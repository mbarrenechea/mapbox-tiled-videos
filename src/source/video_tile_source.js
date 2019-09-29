// @flow

import {extend, pick} from '../util/util';
import {getVideo, ResourceType} from '../util/ajax';
import Texture from '../render/texture';
import {Evented} from '../util/evented';
import {cacheEntryPossiblyAdded} from '../util/tile_request_cache';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import type {Callback} from '../types/callback';
import type {VideoTiledSourceSpecification} from '../style-spec/types';
import type {Source} from './source';
import RasterTileSource from './raster_tile_source';
import VideoCollectionPlayer from './video_collection_player';

function log(s, args) {
    //console.log(s, args);
}

/***
 * Loads video tiles from an XYZ tiles source.
 */
class VideoTileSource extends RasterTileSource implements Source {
    type: 'video-tiled';

    player: VideoCollectionPlayer;
    onRender: Function;
    needsRender: Boolean;

    constructor(id: string, options: VideoTiledSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super(id, options, dispatcher, eventedParent);

        this.needsRender = false;
        this.type = 'video-tiled';

        this.onRender = () => {
            this.needsRender = true;
            this.map.triggerRepaint();
        };

        this.getVideos = () => {
            const tiles = Object.values(this.map.style.sourceCaches[this.id]._tiles);
            return tiles.filter(t => t.video).map(t => t.video);
        };

        this.onVideoError = () => {
            this.map.style.sourceCaches[this.id].reload();
        };

        this.player = new VideoCollectionPlayer(this.onRender, this.getVideos, this.onVideoError);
        
        extend(this, pick(options, ['tileSize', 'playbackRate']));

        this._options = extend({type: 'video-tiled'}, options);

        extend(this, pick(options, ['url', 'scheme']));
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme), this.url, this.tileSize);

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
        if (this.needsRender) {
            const tiles = Object.values(this.map.style.sourceCaches[this.id]._tiles);
            this.needsRender = false;
            return tiles.filter(t => t.video).forEach(t => t.texture.update(t.video, {useMipmap: false}));
        }
    }

    hasTransition() {
        return false;
    }
}

export default VideoTileSource;
