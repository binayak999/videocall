/**
 * WebGPU composite: mix( background, camera, mask ) with optional 9-tap BG blur in the shader.
 * Used when `VITE_CAMERA_BG_COMPOSITE=webgpu` and the pipeline can supply an R8 mask sized to the output.
 */

const SHADER = `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 0.0),
    vec2f(2.0, 0.0),
    vec2f(0.0, 2.0)
  );
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = uv[vi];
  return o;
}

struct Params {
  bg: vec4f,
  blur_uv: f32,
  mode_blur: u32,
  _p0: u32,
  _p1: u32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var video_tex: texture_2d<f32>;
@group(0) @binding(2) var mask_tex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

fn sample_blur(uv: vec2f) -> vec3f {
  let r = params.blur_uv;
  var c = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let ouv = uv + vec2f(f32(dx), f32(dy)) * r;
      c += textureSample(video_tex, samp, ouv).rgb;
    }
  }
  return c / 9.0;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let uv = vec2f(in.uv.x, 1.0 - in.uv.y);
  let fg = textureSample(video_tex, samp, uv).rgb;
  let m = textureSample(mask_tex, samp, uv).r;
  let mm = smoothstep(0.35, 0.65, m);
  var bg: vec3f;
  if (params.mode_blur != 0u) {
    bg = sample_blur(uv);
  } else {
    bg = params.bg.rgb;
  }
  return vec4f(mix(bg, fg, mm), 1.0);
}
`

export interface WebGpuBackgroundRenderer {
  resize: (width: number, height: number) => void
  render: (input: {
    video: HTMLVideoElement
    maskR8: Uint8Array
    width: number
    height: number
    modeBlur: boolean
    solidBgRgb: readonly [number, number, number]
    blurUvRadius: number
  }) => void
  destroy: () => void
}

export async function tryCreateWebGpuBackgroundRenderer(
  canvas: HTMLCanvasElement,
): Promise<WebGpuBackgroundRenderer | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) return null
  let device: GPUDevice
  try {
    device = await adapter.requestDevice()
  } catch {
    return null
  }
  const gpuContext = canvas.getContext('webgpu')
  if (!gpuContext) return null
  const context: GPUCanvasContext = gpuContext
  const format = navigator.gpu.getPreferredCanvasFormat()

  const shaderModule = device.createShaderModule({ code: SHADER })
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 32 },
      },
    ],
  })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] })
  let pipeline: GPURenderPipeline
  try {
    pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    })
  } catch {
    return null
  }

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const uniformBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

  let cw = 0
  let ch = 0
  let videoTex: GPUTexture | null = null
  let maskTex: GPUTexture | null = null
  let bindGroup: GPUBindGroup | null = null

  function ensureTextures(w: number, h: number) {
    if (w === cw && h === ch && videoTex && maskTex && bindGroup) return
    videoTex?.destroy()
    maskTex?.destroy()
    cw = w
    ch = h
    canvas.width = w
    canvas.height = h
    context.configure({ device, format, alphaMode: 'opaque' })
    videoTex = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    maskTex = device.createTexture({
      size: [w, h],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    bindGroup = device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: videoTex.createView() },
        { binding: 2, resource: maskTex.createView() },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    })
  }

  return {
    resize: (width, height) => {
      ensureTextures(width, height)
    },
    render: (input) => {
      const { video, maskR8, width, height, modeBlur, solidBgRgb, blurUvRadius } = input
      if (maskR8.length !== width * height) return
      ensureTextures(width, height)
      if (!videoTex || !maskTex || !bindGroup) return

      device.queue.copyExternalImageToTexture(
        { source: video },
        { texture: videoTex },
        { width, height, depthOrArrayLayers: 1 },
      )
      const align = 256
      const bytesPerRow = Math.max(256, Math.ceil(width / align) * align)
      let maskUpload = maskR8
      if (bytesPerRow !== width) {
        const padded = new Uint8Array(bytesPerRow * height)
        for (let y = 0; y < height; y++) {
          padded.set(maskR8.subarray(y * width, y * width + width), y * bytesPerRow)
        }
        maskUpload = padded
      }
      device.queue.writeTexture(
        { texture: maskTex },
        new Uint8Array(maskUpload),
        { offset: 0, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      )

      const u8 = new Uint8Array(32)
      const dv = new DataView(u8.buffer)
      dv.setFloat32(0, solidBgRgb[0], true)
      dv.setFloat32(4, solidBgRgb[1], true)
      dv.setFloat32(8, solidBgRgb[2], true)
      dv.setFloat32(12, 1, true)
      dv.setFloat32(16, blurUvRadius, true)
      dv.setUint32(20, modeBlur ? 1 : 0, true)
      dv.setUint32(24, 0, true)
      dv.setUint32(28, 0, true)
      device.queue.writeBuffer(uniformBuffer, 0, new Uint8Array(u8))

      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
    },
    destroy: () => {
      videoTex?.destroy()
      maskTex?.destroy()
      uniformBuffer.destroy()
    },
  }
}
