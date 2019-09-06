// @flow

import throttle from '../util/throttle'


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
    onVideoError: Function;
    playTimer: int;

    videos: Array<HTMLVideoElement>;
    seekingVideos: Array<any>;
    currentTimeChanged: boolean;

    constructor(onRender: Function, getVideos: Function, onVideoError: Function) {
        this.onTimeChanged = () => {};
        this.currentTimeMargin = 0.01 // video seeking is a mess in web browsers
        this.playbackRate = 1;
        this.playing = false;
        this.duration = 0;
        this.currentTime = 0;

        this.onRender = onRender;
        this.getVideos = getVideos;
        this.onVideoError = onVideoError;

        this.videos = [];
        this.seekingVideos = [];

        this._syncVideos = throttle(this._syncVideosUnthrottled.bind(this), 150);
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

            let currentTime = player.currentTime + step

            if(currentTime > player.duration) {
                currentTime = 0
            }

            player.setCurrentTimeUnthrottled(currentTime)
        }, dt);
    }

    incrementTime(t, step, margin, duration) {
        t = t + step + margin

        if(t > duration && t <= duration + margin) {
            t = duration
        }
        
        if(t > duration + margin * 2) {
            t = 0
        }

        return t
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
        video.loop = false;
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

    setCurrentTimeUnthrottled(currentTime) {
        if(this.busy && !this.seekingVideos.length) {
            this.busy = false
        }

        if(this.busy) {
            log('Player is already syncing current time, skipping ...')
            return
        }

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

        })
        
        Promise.all(this.videos.map(v => {
            return new Promise((resolve, reject) => {
                // check if video is being seeked already
                if(player.seekingVideos.findIndex(o => o.video === v) !== -1) {
                     console.log('BUG')
                    // this is going to skip time steps
                }
                else {
                    let t = this.incrementTime(currentTime, 0, player.currentTimeMargin, player.duration)
                    // console.log('video time set: ', t)

                    player.seekingVideos.push( { video: v, time: Date.now(), seekTo: t } )
                    v.currentTime = t; // this triggers seeked event
                }
                resolve()
            })
        }))
    }


    /***
     * Syncs all videos to current time
     */
    _syncVideosUnthrottled() {
        this.setCurrentTimeUnthrottled(this.currentTime)
    }

    _subscribeEvents(video) {
        video.addEventListener('seeked', this._onVideoSeeked)
        // video.addEventListener('playing', this._onVideoPlaying)
        // video.addEventListener('timeupdate', this._onVideoTimeUpdate)
    }

    _unsubscribeEvents(video) {
        video.removeEventListener('seeked', this._onVideoSeeked)
        // video.removeEventListener('playing', this._onVideoPlaying)
        // video.removeEventListener('timeupdate', this._onVideoTimeUpdate)

        let index = this.seekingVideos.findIndex(v => v.video === video);
        if (index > -1) {
            let v = this.seekingVideos[index]
            let elapsed = Date.now() - v.time
            // console.log('removed, elapsed ' + index + ': ' + elapsed + ' ms')

            this.seekingVideos.splice(index, 1);
        }
    }

    _onVideoSeeked(e) {
        let video = e.target
        let player = video.player

        // remove element being seeked
        let index = player.seekingVideos.findIndex(v => v.video === video);
        if (index > -1) {
            let v = player.seekingVideos[index]
            let elapsed = Date.now() - v.time

            player.seekingVideos.splice(index, 1);

            // console.log('seeked ' + index + ': ' + elapsed + ' ms, currentTime: ' + v.video.currentTime)
            
            // if video time is broken - reload it!
            if(Math.abs(v.video.currentTime - v.seekTo) > player.currentTimeMargin) {
                console.log(`Error: video seeking is broken, can\'t seek, video time is ${v.video.currentTime}, ` +
                    `but should be ${v.seekTo}, src: ${v.video.firstElementChild.src}`)

                if(v.video.currentTime === 0) {
                    player.onVideoError(v) // HTMLVideoElement is totally broken!
                } else {
                    console.log('The number of video frames is probably incorrect, reverting to the video length')
                }
            }


            if(player.currentTimeChanged && player.seekingVideos.length === 0) {
                player.onRender(player.currentTime) 
                player.currentTimeChanged = false
                player.busy = false

                player.onTimeChanged(player.currentTime)
                //throttle(player.onTimeChanged(player.currentTime), 50);
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
