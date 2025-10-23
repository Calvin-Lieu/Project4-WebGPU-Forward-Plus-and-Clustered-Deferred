import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

export class ForwardPlusRenderer extends renderer.Renderer {
    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;

    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;

    pipeline: GPURenderPipeline;

    constructor(stage: Stage) {
        super(stage);

        // Reusable layout
        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'forward+ scene uniforms bgl',
            entries: [
                { // camera uniforms (viewProj + screen/planes/slices)
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
                { // light set (read-only in fragment)
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                { // clustered light indices (read-only in fragment)
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: 'forward+ scene uniforms bg',
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.getUniformsBuffer() } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.lights.clusterBuffer } },
            ],
        });

        this.depthTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();

        this.pipeline = renderer.device.createRenderPipeline({
            label: 'forward+ pipeline',
            layout: renderer.device.createPipelineLayout({
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: 'forward+ vert',
                    code: shaders.naiveVertSrc,
                }),
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: 'forward+ frag',
                    code: shaders.forwardPlusFragSrc,
                }),
                targets: [{ format: renderer.canvasFormat }],
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        });
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();

        // Run clustering each frame (before the render pass)
        this.lights.doLightClustering(encoder);

        const canvasView = renderer.context.getCurrentTexture().createView();
        const pass = encoder.beginRenderPass({
            label: 'forward+ render pass',
            colorAttachments: [
                {
                    view: canvasView,
                    clearValue: [0, 0, 0, 1],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);

        this.scene.iterate(
            node => {
                pass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
            },
            material => {
                pass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
            },
            prim => {
                pass.setVertexBuffer(0, prim.vertexBuffer);
                pass.setIndexBuffer(prim.indexBuffer, 'uint32');
                pass.drawIndexed(prim.numIndices);
            }
        );

        pass.end();
        renderer.device.queue.submit([encoder.finish()]);
        // this.lights.readClusterDebug();
    }
}
