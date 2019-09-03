// @flow

import window from '../util/window';
import throttle from '../util/throttle'
import { extend, pick } from '../util/util';
import { getVideo, ResourceType } from '../util/ajax';
import Texture from '../render/texture';
import { Event, ErrorEvent, Evented } from '../util/evented';
import loadTileJSON from './load_tilejson';
import { cacheEntryPossiblyAdded } from '../util/tile_request_cache';
import { postTurnstileEvent, postMapLoadEvent } from '../util/mapbox';
import type Dispatcher from '../util/dispatcher';
import type Tile from './tile';
import TileBounds from './tile_bounds';
import type Map from '../ui/map';
import type {Callback} from '../types/callback';
import type {Cancelable} from '../types/cancelable';
import type { VideoTiledSourceSpecification } from '../style-spec/types';
import type {Source} from './source';
import RasterTileSource from './raster_tile_source';

function log(s, args) {
    // console.log(s, args)
}

/***
 * For video reference: https://www.w3.org/2010/05/video/mediaevents.html
 */

class VideoCollectionPlayer {
    playbackRate: number;
    currentTime: number;
    playing: boolean;
    duration: number;

    onTimeChanged: Function;
    onRender: Function;
    playTimer: int;

    videos: Array<HTMLVideoElement>;
    seekingVideos: Array<HTMLVideoElement>;
    currentTimeChanged: boolean;

    constructor(onRender: Function, getVideos: Function) {
        this.onTimeChanged = () => {};
        this.playbackRate = 1;
        this.playing = false;
        this.duration = 0;
        this.currentTime = 0;

        this.onRender = onRender;
        this.getVideos = getVideos;

        this.videos = [];
        this.seekingVideos = [];
        this.seekedCount = 0

        this._syncVideos = throttle(this._syncVideosUnthrottled.bind(this), 100);
    }

    play(dt, step) {
        if(this.playing) {
            return
        }

        this.playing = true

        let player = this;
        dt = dt ? dt : 500; // 2FPS
        step = step ? step : 0.2
        
        log('dt: ', dt)

        this.playTimer = window.setInterval(() => {
            if (!player.playing || player.busy) {
                return;
            }

            let currentTime = player.currentTime + step;

            if(currentTime > player.duration) {
                currentTime = 0
            }

            player.setCurrentTime(currentTime)
        }, dt);
    }

    pause() {
        if(!this.playing) {
            return
        }

        window.clearInterval(this.playTimer)

        this.playing = false
    }

    _onCanPlayThrouth(video, onVideoReady) {
        let onCanPlayThrouthHandler = e => {
            let video = e.target

            log('oncanplaythrough')

            video.removeEventListener('canplaythrough', video.onCanPlayThrouthHandler)

            if(this.videos.includes(video)) {
                return; // already processed
            }

            video.onerror = e => {
                log('Video error: ', e)
            }

            video.width = 512
            video.height = 512
            video.playbackRate = this.playbackRate;
            this.videos.push(video) 
            video.player = this
            this._subscribeEvents(video)

            this.duration = video.duration
            log('duration: ' + video.duration)
            
            if(onVideoReady) {
                onVideoReady(video)
            }

            if(video.currentTime != this.currentTime) {
                this._syncVideos();
                
                log('Syncing newly added video to current time ...')
            }
        }

        video.onCanPlayThrouthHandler = onCanPlayThrouthHandler

        return onCanPlayThrouthHandler
    }

    addVideo(video: HTMLVideoElement, onVideoReady: Function) {
        video.loop = true;
        video.autoplay = false;

        if(video.onCanPlayThrouthHandler) {
            video.onCanPlayThrouthHandler({ target: video })
        } else {
            // use canplaythrough here to handle video load event
            // TODO: find a better way to handle this
            video.addEventListener('canplaythrough', this._onCanPlayThrouth(video, onVideoReady))
        }
    }

    setCurrentTime(currentTime) { 
        this.currentTime = currentTime
        this._syncVideos()
    }

    removeVideo(video) {
        log('remove video')
        this._unsubscribeEvents(video)

        // remove video
        let index = this.videos.indexOf(video);

        if (index > -1) {
            log('remove video at index ' + index)
            this.videos.splice(index, 1);
        } else {
            log('no video found')
        }
    }

    setDuration(duration) {
        this.duration = duration;
    }

    refresh() {
        let visibleVideos = this.getVideos().slice();

        // stop observing videos which are not visible anymore
        let removeVideos = []
        for(let v of this.videos) {
            if(!visibleVideos.includes(v)) {
                removeVideos.push(v)
            }
        }

        for(let v of removeVideos) {
            this.removeVideo(v)
        }

        // add new videos
        for(let v of visibleVideos) {
            if(!this.videos.includes(v)) {
                this.addVideo(v)
            }
        }

        this.seekingVideos = []
        this.busy = false
    }

    needsRefresh() {
        let o = this.getVideos().length != this.videos.length
        if(o) {
            this.refresh()
        }
        return false
    }

    setCurrentTimeUnthrottled(currentTime) {
        if(this.busy && !this.seekingVideos.length) {
            this.busy = false
        }

        if(this.busy) {
            log('Player is already syncing current time, skipping ...')
            return
        }

        this.seekedCount = 0

        this.busy = true

        this.refresh()

        this.currentTime = currentTime;

        // log('Player, set current time: ', currentTime)

        let player = this;

        this.currentTimeChanged = true

        this.videos.forEach(v => {
            // if(v.currentTime == currentTime) {
            //     return
            // }

            player.seekingVideos.push(v)
            v.currentTime = currentTime; // this triggers seeked event
        })
    }


    /***
     * Syncs all videos to current time
     */
    _syncVideosUnthrottled() {
        this.setCurrentTimeUnthrottled(this.currentTime)
    }

    _subscribeEvents(video) {
        video.addEventListener('seeked', this._onVideoSeeked)
        video.addEventListener('playing', this._onVideoPlaying)
        video.addEventListener('timeupdate', this._onVideoTimeUpdate)
    }

    _unsubscribeEvents(video) {
        video.removeEventListener('seeked', this._onVideoSeeked)
        video.removeEventListener('playing', this._onVideoPlaying)
        video.removeEventListener('timeupdate', this._onVideoTimeUpdate)

        let index = this.seekingVideos.indexOf(video);
        if (index > -1) {
            this.seekingVideos.splice(index, 1);
        }
    }

    _onVideoSeeked(e) {
        let video = e.target
        let player = video.player

        // remove element being seeked
        let index = player.seekingVideos.indexOf(video);
        if (index > -1) {
            player.seekingVideos.splice(index, 1);

            if(player.currentTimeChanged && player.seekingVideos.length === 0) {
                player.onRender(player.currentTime) 
                player.currentTimeChanged = false
                player.busy = false

                throttle(player.onTimeChanged(player.currentTime), 300);
            }
            else {
                player.seekedCount += 1
            }
        }
    }

    _onVideoPlaying(e) {
        // log('playing')
    }

    _onVideoTimeUpdate(e) {
        // log('timeupdate')
    }
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

        this.type = 'video-tiled';

        this.onRender = time => {
            this.needsRender = true
            this.fire(new Event('repaint'))
            this.map.triggerRepaint()
        }

        this.getVideos = () => {
            let tiles = Object.values(this.map.style.sourceCaches[this.id]._tiles)
            return tiles.filter(t => t.video).map(t => t.video)
        }

        this.player = new VideoCollectionPlayer(this.onRender, this.getVideos);

        extend(this, pick(options, ['tileSize', 'playbackRate']));

        this._options = extend({ type: 'video-tiled' }, options);
        extend(this, pick(options, ['url', 'scheme']));
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = this.map._requestManager.normalizeTileURL(tile.tileID.canonical.url(this.tiles, this.scheme), this.url, this.tileSize);

        const onLoaded = (err, video) => {
            delete tile.request;

            if (tile.aborted) {
                tile.state = 'unloaded';
                log('unloaded')
                callback(null);
            } else if (err) {
                tile.state = 'errored';
                log('errored')
                callback(err);
            } else {
                tile.state = 'loading';
                
                // add video to the player, add tile once (if) video is ready to play
                this.player.addVideo(video, video => {
                    log('adding video tile')
                    this.addTile(tile, video, callback)
                });
            }
        }

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
        tile.texture = new Texture(context, video, gl.RGBA, { useMipmap: false });
        tile.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

        let tileSource = this;

        this.on('repaint', () => {
            // log('repaint')
            tile.texture.update(video, { useMipmap: false })

            this.needsRender = false;
        })
    
        // if (context.extTextureFilterAnisotropic) {
        //     gl.texParameterf(gl.TEXTURE_2D, context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, context.extTextureFilterAnisotropicMax);
        // }

        tile.state = 'loaded';
        cacheEntryPossiblyAdded(this.dispatcher);
        callback(null);

        if(tile.video) {
            this.player.addVideo(tile.video)
        }
    }

    unloadTile(tile: Tile, callback: Callback<void>) {
        RasterTileSource.prototype.unloadTile.call(this, tile, callback)

        log('unload tile')


        if(tile.video) {
            log('unload tile with video')
            this.player.removeVideo(tile.video)
        }
    }

    prepare() {
        // if(this.needsRepaint) {
        //     this.fire(new Event('repaint'))
        // }
    }    

    hasTransition() {
        return this.needsRender || this.player.needsRefresh();
    }
};

export default VideoTileSource;
