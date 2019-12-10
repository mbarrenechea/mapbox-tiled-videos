// @flow

import {extend, pick} from '../util/util';
import {getVideo, ResourceType} from '../util/ajax';
import Texture from '../render/texture';
import {Event, Evented} from '../util/evented';
import Point from '@mapbox/point-geometry';
import {polygonIntersectsBox} from '../util/intersection_tests';
import {cacheEntryPossiblyAdded} from '../util/tile_request_cache';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {VideoTiledSourceSpecification} from '../style-spec/types';
import type {Source} from './source';
import RasterTileSource from './raster_tile_source';
import VideoCollectionPlayer from './video_collection_player';

function log(s, args) {
    // console.log(s, args);
}

/***
 * Loads video tiles from an XYZ tiles source.
 */
class VideoTileSource extends RasterTileSource implements Source {
    type: 'video-tiled';

    player: VideoCollectionPlayer;
    onRender: Function;
    geometryFilter: GeoJSON | string;
    playbackRate: Number;

    constructor(id: string, options: VideoTiledSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super(id, options, dispatcher, eventedParent);

        this.type = 'video-tiled';
        this.tiles = [];
        this.geometryFilter = null;
        this.initialized = false;
        this.playbackRate = 0;

        this.onRender = () => {
            let tiles = Object.values(this.map.style.sourceCaches[this.id]._tiles);
            tiles.map(tile => tile.needsRender = true)
            this.map.triggerRepaint();
        };

        this.getVideos = () => {
            const tiles = Object.values(this.map.style.sourceCaches[this.id]._tiles);

            return tiles.filter(t => t.video).map(t => t.video);

            /*
            let maxZoom = Math.round(this.map.getZoom())

            if(tiles.length > 0) {
                let zooms = tiles.map(t => t.tileID.canonical.z)
                maxZoom = Math.max(...zooms)
            }
            
            return tiles.filter(t => t.video && t.tileID.canonical.z === maxZoom).map(t => t.video);
            */
        };

        this.onVideoError = () => {
            this.map.style.sourceCaches[this.id].reload();
        };

        this.player = new VideoCollectionPlayer(this.onRender, this.getVideos, this.onVideoError);
        
        extend(this, pick(options, ['tileSize', 'playbackRate', 'geometryFilter']));

        this._options = extend({type: 'video-tiled'}, options);

        extend(this, pick(options, ['tiles', 'scheme']));

        if(this.playbackRate) {
            this.player.playbackRate = this.playbackRate
        }
    }

    load() {
        this.fire(new Event('dataloading', {dataType: 'source'}));

        if(!this.geometryFilter) {
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));

            super.load() // makes sure RasterTileSource is initialized properly

            return
        }

        let handleLoaded = geojson => {
            this.geometryFilter = geojson.coordinates[0].map(c => new Point(c[0], c[1]))

            // let the SourceCache know its ok to start requesting tiles.
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));

            super.load() // makes sure RasterTileSource is initialized properly
        }

        if(typeof(this.geometryFilter) === 'string') {
            let url = this.geometryFilter

            fetch(url)
                .then(response => response.json())
                .then(geojson => handleLoaded(geojson))
        } else {
            // load GeoJSON directly
            handleLoaded(this.geometryFilter)
        }
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme), this.url, this.tileSize);

        // do not load tiles if they are not covered by geometry, when geometry is defined
        if(this.geometryFilter && !this.tileIntersectsWithGeometry(tile)) {
            tile.state = 'errored';
            return
        }

        log('Tile added: ' + tile.tileID.canonical.x + ', ' + tile.tileID.canonical.y)

        const onLoaded = (err, video) => {
            delete tile.request;

            if (tile.aborted) {
                tile.state = 'unloaded';
                log('unloaded');
                callback(null);
            } else if (err) {
                tile.state = 'errored';
                log('errored');
                callback(err);
            } else {
                tile.state = 'loading';

                // add video to the player, add tile once (if) video is ready to play
                this.player.addVideo(video, video => {
                    log('adding video tile');
                    this.addTile(tile, video, callback);
                });
            }
        };

        tile.request = getVideo([this.map._requestManager.transformRequest(url, ResourceType.Tile).url], onLoaded);
    }

    /***
     * Computes tile bounds given tile XYZ
     */
    getTileBounds(tx, ty, z) {
        let xmin = tx / Math.pow(2, z) * 360 - 180
        let xmax = (tx + 1) / Math.pow(2, z) * 360 - 180
        
        var n = Math.PI - 2 * Math.PI * ty / Math.pow(2, z)
        var ymin = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI

        var n = Math.PI - 2 * Math.PI * (ty + 1) / Math.pow(2, z)
        var ymax = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI

        return [xmin, xmax, ymin, ymax]
    }
    
    /***
     * Checks if tile is covered by geometry.
     */
    tileIntersectsWithGeometry(tile) {
        let t = tile.tileID.canonical
        let [xmin, xmax, ymin, ymax] = this.getTileBounds(t.x, t.y, t.z)
        let check = polygonIntersectsBox(this.geometryFilter, xmin, ymax, xmax, ymin)

        return check
    }

    /***
     * Called when the tile is added.
     */
    addTile(tile: Tile, video: HTMLVideoElement, callback: Callback<void>) {
        tile.video = video;

        if (this.map._refreshExpiredTiles) {
            tile.setExpiryData(video);
        }

        delete (video: any).cacheControl;
        delete (video: any).expires;

        const context = this.map.painter.context;
        const gl = context.gl;

        // TODO: in the future use WebGL video extention: https://www.khronos.org/registry/webgl/extensions/proposals/WEBGL_video_texture/
        tile.texture = new Texture(context, video, gl.RGBA, {useMipmap: false});
        tile.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
        tile.state = 'loaded';
        log('Tile loaded: ' + tile.tileID.canonical.x + ', ' + tile.tileID.canonical.y)
        cacheEntryPossiblyAdded(this.dispatcher);
        callback(null);

        if (tile.video) {
            // this.player.addVideo(tile.video);
        }
    }

    unloadTile(tile: Tile, callback: Callback<void>) {
        RasterTileSource.prototype.unloadTile.call(this, tile, callback);

        log('unload tile');

        if (tile.video) {
            log('unload tile with video');
            this.player.removeVideo(tile.video);
        }
    }

    prepare() {
        let playing = this.getVideos().some(v => !v.paused)

        if(playing) {
           return
        }

        // manual playing
        let tilesToRender = Object.values(this.map.style.sourceCaches[this.id]._tiles).filter(tile => tile.video && tile.needsRender)

        if (tilesToRender.length > 0) {
            tilesToRender.forEach(tile => { 
                tile.texture.update(tile.video, {useMipmap: false})
                tile.needsRender = false
            });

            this.player.busy = false // done
            this.player.onAfterVideoSync();

            return
        }

        if(this.getVideos().length !== this.player.videos.length) {
            this.player.refresh()
            this.onRender()     
        }
    }

    hasTransition() {
        // console.log('hasTransition')
        return this.player.onHasTransition()

        // return this.getVideos().some(v => !v.paused)
        // return false;
    }
}

export default VideoTileSource;
