// @flow

import throttle from '../util/throttle';

function log(s, args) {
    //  console.log(s, args)
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
    onBeforeVideoSync: Function;
    onAfterVideoSync: Function;
    onRender: Function;
    onVideoError: Function;
    playTimer: int;

    videos: Array < HTMLVideoElement > ;
    seekingVideos: Array < any > ;
    currentTimeChanged: boolean;

    constructor(onRender: Function, getVideos: Function, onVideoError: Function) {
        this.onTimeChanged = () => {}; // all videos are synced
        this.onBeforeVideoSync = () => {};
        this.onAfterVideoSync = () => {}; 
        this.currentTimeMargin = 0.01; // video seeking is a mess in web browsers
        this.playbackRate = 1;
        this.playing = false;
        this.duration = 0;
        this.currentTime = 0;

        this.onRender = onRender;
        this.getVideos = getVideos;
        this.onVideoError = onVideoError;

        this.videos = [];
        this.seekingVideos = [];

        this._syncVideos = throttle(this._syncVideosUnthrottled.bind(this), 30);
        this._refreshVideos = throttle(this.onVideoError.bind(this), 1000);
    }

    onHasTransition() {
        if(!this.playing) {
            return false
        }

        if(!this.busy) {

            if(this.playing) {
                if(1000 / (Date.now() - this.elapsedStart) > this.maxFps) {
                    return true; // no need to update, maxFps reached
                }

                this.elapsedStart = Date.now()

                let currentTime = this.currentTime + this.step;

                if (currentTime > this.duration) {
                    currentTime = 0;
                }

                // this.setCurrentTime(currentTime)
                this.setCurrentTimeUnthrottled(currentTime);
            }
        }

        return false
    }

    play(maxFps, step) {
        if (this.playing) {
            return;
        }

        this.maxFps = maxFps;
        this.step = step;
        this.playing = true;

        this.onRender()
    }

    play_(dt, step) {
        if (this.playing) {
            return;
        }

        this.playing = true;

        const player = this;
        dt = dt ? dt : 500; // 2FPS
        step = step ? step : 0.2;

        log('dt: ', dt);

        const updateFrame = () => {
            if (!player.playing || player.busy) {
                return;
            }

            let currentTime = player.currentTime + step;

            if (currentTime > player.duration) {
                currentTime = 0;
            }

            player.setCurrentTimeUnthrottled(currentTime);

            if (player.playing) {
                window.setTimeout(() => updateFrame(), dt / this.playbackRate);
            }
        };

        updateFrame();
    }

    incrementTime(t, step, margin, duration) {
        t = t + step + margin;

        if (t > duration && t <= duration + margin) {
            t = duration;
        }

        if (t > duration + margin * 2) {
            t = 0;
        }

        return t;
    }

    pause() {
        if (!this.playing) {
            return;
        }

        // window.clearInterval(this.playTimer)

        this.playing = false;
    }

    _onCanPlayThrough(video, onVideoReady) {
        const onCanPlayThroughHandler = e => {
            const video = e.target;

            log('oncanplaythrough');

            video.removeEventListener('canplaythrough', video.onCanPlayThroughHandler);

            if (this.videos.includes(video)) {
                return; // already processed
            }

            video.onerror = e => {
                log('video error: ', e);
            };

            video.width = 512;
            video.height = 512;
            video.playbackRate = this.playbackRate;
            this.videos.push(video);
            video.player = this;
            this._subscribeEvents(video);

            this.duration = video.duration;
            log(`duration: ${video.duration}`);

            if (onVideoReady) {
                log('video ready', video)
                onVideoReady(video);
            }

            if (video.currentTime !== this.currentTime) {
                // this._syncVideos();
                // log('Syncing newly added video to current time ...');
            }
        };

        video.onCanPlayThroughHandler = onCanPlayThroughHandler;

        return onCanPlayThroughHandler;
    }

    addVideo(video: HTMLVideoElement, onVideoReady: Function) {
        video.loop = false;
        video.autoplay = false;

        if (video.onCanPlayThroughHandler) {
            video.onCanPlayThroughHandler({
                target: video
            });
        } else {
            // use canplaythrough here to handle video load event
            // TODO: find a better way to handle this
            video.addEventListener('canplaythrough', this._onCanPlayThrough(video, onVideoReady));
        }

        // this.refresh();
        this.setCurrentTimeUnthrottled(this.currentTime);
    }

    setCurrentTime(currentTime) {
        this.currentTime = currentTime;
        this._syncVideos();
    }

    removeVideo(video) {
        log('video removed', video);
        this._unsubscribeEvents(video);

        // remove video
        const index = this.videos.indexOf(video);

        if (index > -1) {
            log(`remove video at index ${index}`);
            this.videos.splice(index, 1);
        } else {
            log('no video found');
        }
    }

    setDuration(duration) {
        this.duration = duration;
    }

    refresh() {
        const visibleVideos = this.getVideos().slice();

        // stop observing videos which are not visible anymore
        const removeVideos = [];
        for (const v of this.videos) {
            if (!visibleVideos.includes(v)) {
                removeVideos.push(v);
            }
        }

        for (const v of removeVideos) {
            this.removeVideo(v);
        }

        // add new videos
        for (const v of visibleVideos) {
            if (!this.videos.includes(v)) {
                this.addVideo(v);
            }
        }

        this.seekingVideos = [];
        // this.busy = false;
    }

    setCurrentTimeUnthrottled(currentTime) {
        if (this.busy && !this.seekingVideos.length) {
            // this.busy = false;
        }

        if (this.busy) {
            log('Player is already syncing current time, skipping ...');
            return;
        }

        this.busy = true;

        this.onBeforeVideoSync();

        this.refresh();

        this.currentTime = currentTime;

        // log('Player, set current time: ', currentTime)

        const player = this;

        this.currentTimeChanged = true;

        this.videos.forEach(v => {
            // if(v.currentTime == currentTime) {
            //     return
            // }

        });

        Promise.all(this.videos.map(v => {
            return new Promise((resolve, reject) => {
                // check if video is being seeked already
                if (player.seekingVideos.findIndex(o => o.video === v) === -1) {
                    const t = this.incrementTime(currentTime, 0, player.currentTimeMargin, player.duration);

                    player.seekingVideos.push({
                        video: v,
                        time: Date.now(),
                        seekTo: t
                    });
                    v.currentTime = t; // this triggers seeked event
                }
                resolve();
            });
        }));
    }

    /***
     * Syncs all videos to current time
     */
    _syncVideosUnthrottled() {
        this.setCurrentTimeUnthrottled(this.currentTime);
    }

    _subscribeEvents(video) {
        video.addEventListener('seeked', this._onVideoSeeked);
        // video.addEventListener('playing', this._onVideoPlaying)
        // video.addEventListener('timeupdate', this._onVideoTimeUpdate)
    }

    _unsubscribeEvents(video) {
        video.removeEventListener('seeked', this._onVideoSeeked);
        // video.removeEventListener('playing', this._onVideoPlaying)
        // video.removeEventListener('timeupdate', this._onVideoTimeUpdate)

        const index = this.seekingVideos.findIndex(v => v.video === video);
        if (index > -1) {
            // const v = this.seekingVideos[index];
            // const elapsed = Date.now() - v.time;

            this.seekingVideos.splice(index, 1);
        }
    }

    _onVideoSeeked(e) {
        const video = e.target;
        const player = video.player;

        // remove element being seeked
        const index = player.seekingVideos.findIndex(v => v.video === video);
        if (index > -1) {
            const v = player.seekingVideos[index];
            const elapsed = Date.now() - v.time;

            // console.log('seeked ' + index + ': ' + elapsed + ' ms')

            player.seekingVideos.splice(index, 1);

            // if video time is broken - reload it!
            if (Math.abs(v.video.currentTime - v.seekTo) > player.currentTimeMargin) {
                console.log(`Error: video seeking is broken, can\'t seek, video time is ${v.video.currentTime}, ` +
                    `but should be ${v.seekTo}, src: ${v.video.firstElementChild.src}`);

                if (v.video.currentTime === 0) {
                    player._refreshVideos();
                } else {
                    console.log('The number of video frames is probably incorrect, reverting to the video length');
                }
            }

            if (player.currentTimeChanged && player.seekingVideos.length === 0) {
                // console.log('seeked all videos, ' + player.seekingVideos.length)
                player.onRender(player.currentTime);
                player.currentTimeChanged = false;
                // player.busy = false;

                player.onRender()

                // player.onTimeChanged(player.currentTime)
                throttle(player.onTimeChanged(player.currentTime), 250);
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

export default VideoCollectionPlayer;
