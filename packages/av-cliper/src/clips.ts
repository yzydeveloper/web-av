// 避免使用 DOM API 确保这些 Clip 能在 Worker 中运行
import {
  audioResample,
  concatFloat32Array,
  decodeGif,
  extractPCM4AudioBuffer,
  extractPCM4AudioData,
  sleep
} from './av-utils'
import { Log } from './log'
import { demuxcode } from './mp4-utils'

export interface IClip {
  /**
   * 当前瞬间，需要的数据
   * @param time 时间，单位 微秒
   */
  tick: (time: number) => Promise<{
    video?: VideoFrame | ImageBitmap
    audio?: Float32Array[]
    state: 'done' | 'success'
  }>

  ready: Promise<void>

  meta: {
    // 微秒
    duration: number
    width: number
    height: number
  }

  destroy: () => void
}

export class MP4Clip implements IClip {
  #videoFrames: VideoFrame[] = []

  #ts = 0

  ready: Promise<void>

  #destroyed = false

  meta = {
    // 微秒
    duration: 0,
    width: 0,
    height: 0,
    audioSampleRate: DEFAULT_AUDIO_SAMPLE_RATE,
    audioChanCount: 2
  }

  #audioChan0 = new Float32Array(0)
  #audioChan1 = new Float32Array(0)

  #volume = 1

  #hasAudioTrack = false

  #demuxcoder: ReturnType<typeof demuxcode> | null = null

  constructor (
    rs: ReadableStream<Uint8Array>,
    opts: { audio: boolean | { volume: number } } = { audio: true }
  ) {
    this.ready = new Promise(resolve => {
      let lastVf: VideoFrame | null = null
      this.#volume =
        typeof opts.audio === 'object' && 'volume' in opts.audio
          ? opts.audio.volume
          : 1
      this.#demuxcoder = demuxcode(
        rs,
        { audio: opts.audio !== false },
        {
          onReady: info => {
            this.#hasAudioTrack = info.audioTracks.length > 0
            const videoTrack = info.videoTracks[0]
            this.meta = {
              duration: (info.duration / info.timescale) * 1e6,
              width: videoTrack.track_width,
              height: videoTrack.track_height,
              audioSampleRate: DEFAULT_AUDIO_SAMPLE_RATE,
              audioChanCount: 2
            }
            Log.info('MP4Clip info:', info)
            resolve()
            this.#demuxcoder?.seek(0)
          },
          onVideoOutput: vf => {
            this.#videoFrames.push(vf)
            lastVf = vf
          },
          onAudioOutput: async ad => {
            this.#audioData2PCMBuf(ad)
          },
          onComplete: () => {
            Log.info('MP4Clip decode complete')
            if (lastVf == null) throw Error('mp4 parse error, no video frame')
            this.meta.duration = lastVf.timestamp + (lastVf.duration ?? 0)
          }
        }
      )
    })
  }

  #audioData2PCMBuf = (() => {
    let chan0 = new Float32Array(0)
    let chan1 = new Float32Array(0)

    let needResample = true
    const flushResampleData = async (curRate: number) => {
      const data = [chan0, chan1]
      chan0 = new Float32Array(0)
      chan1 = new Float32Array(0)

      const pcmArr = await audioResample(data, curRate, {
        rate: DEFAULT_AUDIO_SAMPLE_RATE,
        chanCount: 2
      })
      this.#audioChan0 = concatFloat32Array([this.#audioChan0, pcmArr[0]])
      this.#audioChan1 = concatFloat32Array([
        this.#audioChan1,
        pcmArr[1] ?? pcmArr[0]
      ])
    }
    return (ad: AudioData) => {
      needResample = ad.sampleRate !== DEFAULT_AUDIO_SAMPLE_RATE

      const pcmArr = extractPCM4AudioData(ad)
      let curRate = ad.sampleRate
      ad.close()
      if (this.#volume !== 1) {
        for (const pcm of pcmArr)
          for (let i = 0; i < pcm.length; i++) pcm[i] *= this.#volume
      }

      if (needResample) {
        chan0 = concatFloat32Array([chan0, pcmArr[0]])
        chan1 = concatFloat32Array([chan1, pcmArr[1] ?? pcmArr[0]])
        if (chan0.length >= curRate / 5) {
          // 累计 200ms 的音频数据再进行采样，过短可能导致声音有卡顿
          flushResampleData(curRate).catch(Log.error)
        }
      } else {
        this.#audioChan0 = concatFloat32Array([this.#audioChan0, pcmArr[0]])
        this.#audioChan1 = concatFloat32Array([
          this.#audioChan1,
          pcmArr[1] ?? pcmArr[0]
        ])
      }
    }
  })()

  async #nextVideo (time: number): Promise<VideoFrame | null> {
    if (this.#videoFrames.length === 0) {
      if (
        this.#destroyed ||
        this.#demuxcoder?.getDecodeQueueSize().video === 0
      ) {
        return null
      }

      await sleep(5)
      return this.#nextVideo(time)
    }

    const rs = this.#videoFrames[0]
    if (time < rs.timestamp) {
      return null
    }

    this.#videoFrames.shift()
    return rs
  }

  async #nextAudio (deltaTime: number): Promise<Float32Array[]> {
    const frameCnt = Math.ceil(deltaTime * (this.meta.audioSampleRate / 1e6))
    if (frameCnt === 0) return []
    // 小心避免死循环
    if (
      this.#audioChan0.length < frameCnt &&
      !this.#destroyed &&
      this.#demuxcoder?.getDecodeQueueSize().audio !== 0
    ) {
      await sleep(5)
      return this.#nextAudio(deltaTime)
    }

    const audio = [
      this.#audioChan0.slice(0, frameCnt),
      this.#audioChan1.slice(0, frameCnt)
    ]

    this.#audioChan0 = this.#audioChan0.slice(frameCnt)
    if (this.meta.audioChanCount > 1) {
      this.#audioChan1 = this.#audioChan1.slice(frameCnt)
    }
    return audio
  }

  async tick (time: number): Promise<{
    video?: VideoFrame
    audio: Float32Array[]
    state: 'success' | 'done'
  }> {
    if (time < this.#ts) throw Error('time not allow rollback')
    if (time >= this.meta.duration) {
      return { audio: [], state: 'done' }
    }

    const audio = this.#hasAudioTrack
      ? await this.#nextAudio(time - this.#ts)
      : []
    const video = await this.#nextVideo(time)
    this.#ts = time
    if (video == null) {
      return { audio, state: 'success' }
    }

    return { video, audio, state: 'success' }
  }

  destroy (): void {
    Log.info('MP4Clip destroy, ts:', this.#ts)
    this.#destroyed = true
    this.#demuxcoder?.stop()
    this.#videoFrames.forEach(f => f.close())
    this.#videoFrames = []
  }
}

export const DEFAULT_AUDIO_SAMPLE_RATE = 48000

export class AudioClip implements IClip {
  static ctx = new AudioContext({ sampleRate: DEFAULT_AUDIO_SAMPLE_RATE })

  ready: Promise<void>

  meta = {
    // 微秒
    duration: 0,
    width: 0,
    height: 0,
    sampleRate: DEFAULT_AUDIO_SAMPLE_RATE,
    numberOfChannels: 2
  }

  #chan0Buf = new Float32Array()
  #chan1Buf = new Float32Array()

  // 微秒
  #ts = 0

  #frameOffset = 0

  #opts

  constructor (buf: ArrayBuffer, opts?: { loop?: boolean; volume?: number }) {
    this.#opts = {
      loop: false,
      volume: 1,
      ...opts
    }

    this.ready = this.#init(AudioClip.ctx, buf)
  }

  async #init (
    ctx: OfflineAudioContext | AudioContext,
    buf: ArrayBuffer
  ): Promise<void> {
    const tStart = performance.now()
    const audioBuf = await ctx.decodeAudioData(buf)
    Log.info(
      'Audio clip decoded complete:',
      audioBuf,
      performance.now() - tStart
    )

    const pcm = extractPCM4AudioBuffer(audioBuf)
    this.meta = {
      ...this.meta,
      duration: audioBuf.duration * 1e6,
      sampleRate: audioBuf.sampleRate,
      numberOfChannels: audioBuf.numberOfChannels
    }

    this.#chan0Buf = pcm[0]
    // 单声道 转 立体声
    this.#chan1Buf = pcm[1] ?? this.#chan0Buf

    const volume = this.#opts.volume
    if (volume !== 1) {
      for (const chan of pcm)
        for (let i = 0; i < chan.length; i += 1) chan[i] *= volume
    }

    Log.info(
      'Audio clip convert to AudioData, time:',
      performance.now() - tStart
    )
  }

  async tick (time: number): Promise<{
    audio: Float32Array[]
    state: 'success' | 'done'
  }> {
    if (time < this.#ts) throw Error('time not allow rollback')
    if (!this.#opts.loop && time >= this.meta.duration) {
      return { audio: [], state: 'done' }
    }

    const deltaTime = time - this.#ts
    this.#ts = time

    const frameCnt = Math.ceil(deltaTime * (this.meta.sampleRate / 1e6))
    const endIdx = this.#frameOffset + frameCnt
    const audio = [
      ringSliceFloat32Array(this.#chan0Buf, this.#frameOffset, endIdx),
      ringSliceFloat32Array(this.#chan1Buf, this.#frameOffset, endIdx)
    ]
    this.#frameOffset = endIdx

    return { audio, state: 'success' }
  }

  destroy (): void {
    this.#chan0Buf = new Float32Array(0)
    this.#chan1Buf = new Float32Array(0)
    Log.info('---- audioclip destroy ----')
  }
}

export class ImgClip implements IClip {
  ready: Promise<void>

  meta = {
    // 微秒
    duration: 0,
    width: 0,
    height: 0
  }

  #img: ImageBitmap | null = null

  #frames: VideoFrame[] = []

  constructor (
    dataSource: ImageBitmap | { type: 'gif'; stream: ReadableStream }
  ) {
    if (dataSource instanceof ImageBitmap) {
      this.#img = dataSource
      this.meta.width = dataSource.width
      this.meta.height = dataSource.height
      this.ready = Promise.resolve()
    } else {
      this.ready = this.#gifInit(dataSource.stream)
    }
  }

  async #gifInit (stream: ReadableStream) {
    this.#frames = await decodeGif(stream)
    const firstVf = this.#frames[0]
    if (firstVf == null) throw Error('No frame available in gif')

    this.meta = {
      duration: this.#frames.reduce((acc, cur) => acc + (cur.duration ?? 0), 0),
      width: firstVf.codedWidth,
      height: firstVf.codedHeight
    }
  }

  async tick (time: number): Promise<{
    video: ImageBitmap | VideoFrame
    state: 'success'
  }> {
    if (this.#img != null) {
      return {
        video: await createImageBitmap(this.#img),
        state: 'success'
      }
    }
    const tt = time % this.meta.duration
    return {
      video: (
        this.#frames.find(
          f => tt >= f.timestamp && tt <= f.timestamp + (f.duration ?? 0)
        ) ?? this.#frames[0]
      ).clone(),
      state: 'success'
    }
  }

  destroy (): void {
    Log.info('ImgClip destroy')
    this.#img?.close()
    this.#frames.forEach(f => f.close())
  }
}

/**
 *  循环 即 环形取值
 */
function ringSliceFloat32Array (
  data: Float32Array,
  start: number,
  end: number
): Float32Array {
  const cnt = end - start
  const rs = new Float32Array(cnt)
  let i = 0
  while (i < cnt) {
    rs[i] = data[(start + i) % data.length]
    i += 1
  }
  return rs
}
