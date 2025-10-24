import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

interface BufferConfiguration {
    lightDataBuffer: GPUBuffer;
    lightIndicesBuffer: GPUBuffer;
}

interface PipelineResources {
    computeLayout: GPUBindGroupLayout;
    computeBindGroup: GPUBindGroup;
    computePipeline: GPUComputePipeline;
    renderLayout: GPUBindGroupLayout;
    renderBindGroup: GPUBindGroup;
    renderPipeline: GPURenderPipeline;
}

export class ForwardPlusRenderer extends renderer.Renderer {
    private bufferConfig: BufferConfiguration;
    private pipelineResources: PipelineResources;
    private depthResource: { texture: GPUTexture; view: GPUTextureView };

    constructor(stage: Stage) {
        super(stage);

        this.bufferConfig = this.createBufferConfiguration();
        this.depthResource = this.createDepthResource();
        this.pipelineResources = this.assembleAllPipelines();
    }

    private calculateTileMetrics() {
        const totalTileCount = shaders.constants.tilesX * shaders.constants.tilesY * shaders.constants.tilesZ;
        const lightDataStride = 16;
        const maxIndicesPerGrid = totalTileCount * shaders.constants.maxLightsPerTile;

        return { totalTileCount, lightDataStride, maxIndicesPerGrid };
    }

    private createBufferConfiguration(): BufferConfiguration {
        const metrics = this.calculateTileMetrics();

        return {
            lightDataBuffer: this.allocateStorageBuffer(
                "light organization buffer",
                4 + (metrics.totalTileCount * metrics.lightDataStride)
            ),
            lightIndicesBuffer: this.allocateStorageBuffer(
                "light reference buffer",
                metrics.maxIndicesPerGrid * 4
            )
        };
    }

    private allocateStorageBuffer(label: string, size: number): GPUBuffer {
        return renderer.device.createBuffer({
            label,
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
    }

    private createDepthResource() {
        const texture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT
        });

        return { texture, view: texture.createView() };
    }

    private buildComputeResources() {
        const layout = this.createComputeBindGroupLayout();
        const bindGroup = this.createComputeBindGroup(layout);
        const pipeline = this.createComputePipeline(layout);

        return { computeLayout: layout, computeBindGroup: bindGroup, computePipeline: pipeline };
    }

    private createComputeBindGroupLayout(): GPUBindGroupLayout {
        return renderer.device.createBindGroupLayout({
            label: "compute organization layout",
            entries: this.getComputeBindingEntries()
        });
    }

    private getComputeBindingEntries(): GPUBindGroupLayoutEntry[] {
        return [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
        ];
    }

    private createComputeBindGroup(layout: GPUBindGroupLayout): GPUBindGroup {
        return renderer.device.createBindGroup({
            label: "compute organization group",
            layout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.bufferConfig.lightDataBuffer } },
                { binding: 3, resource: { buffer: this.bufferConfig.lightIndicesBuffer } }
            ]
        });
    }

    private createComputePipeline(layout: GPUBindGroupLayout): GPUComputePipeline {
        return renderer.device.createComputePipeline({
            label: "spatial organization pipeline",
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "spatial organization compute",
                    code: shaders.clusteringComputeSrc
                }),
                entryPoint: "main"
            }
        });
    }

    private buildRenderResources() {
        const layout = this.createRenderBindGroupLayout();
        const bindGroup = this.createRenderBindGroup(layout);
        const pipeline = this.createRenderPipeline(layout);

        return { renderLayout: layout, renderBindGroup: bindGroup, renderPipeline: pipeline };
    }

    private createRenderBindGroupLayout(): GPUBindGroupLayout {
        return renderer.device.createBindGroupLayout({
            label: "render scene layout",
            entries: this.getRenderBindingEntries()
        });
    }

    private getRenderBindingEntries(): GPUBindGroupLayoutEntry[] {
        return [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
        ];
    }

    private createRenderBindGroup(layout: GPUBindGroupLayout): GPUBindGroup {
        return renderer.device.createBindGroup({
            label: "render scene group",
            layout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.bufferConfig.lightDataBuffer } },
                { binding: 3, resource: { buffer: this.bufferConfig.lightIndicesBuffer } }
            ]
        });
    }

    private createRenderPipeline(layout: GPUBindGroupLayout): GPURenderPipeline {
        return renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "forward rendering layout",
                bindGroupLayouts: [layout, renderer.modelBindGroupLayout, renderer.materialBindGroupLayout]
            }),
            depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "forward vertex processor",
                    code: shaders.naiveVertSrc
                }),
                buffers: [renderer.vertexBufferLayout]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "forward fragment processor",
                    code: shaders.forwardPlusFragSrc
                }),
                targets: [{ format: renderer.canvasFormat }]
            }
        });
    }

    private assembleAllPipelines(): PipelineResources {
        const computeResources = this.buildComputeResources();
        const renderResources = this.buildRenderResources();

        return { ...computeResources, ...renderResources };
    }

    private executeComputePhase(encoder: GPUCommandEncoder) {
        const pass = encoder.beginComputePass({ label: "spatial organization phase" });
        pass.setPipeline(this.pipelineResources.computePipeline);
        pass.setBindGroup(0, this.pipelineResources.computeBindGroup);

        const metrics = this.calculateTileMetrics();
        const dispatchCount = Math.ceil(metrics.totalTileCount / shaders.constants.tileWorkgroupSize);
        pass.dispatchWorkgroups(dispatchCount);
        pass.end();
    }

    private executeRenderPhase(encoder: GPUCommandEncoder) {
        const canvasView = renderer.context.getCurrentTexture().createView();
        const pass = encoder.beginRenderPass({
            label: "forward shading phase",
            colorAttachments: [{
                view: canvasView,
                clearValue: [0, 0, 0, 1],
                loadOp: "clear",
                storeOp: "store"
            }],
            depthStencilAttachment: {
                view: this.depthResource.view,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store"
            }
        });

        this.configureRenderState(pass);
        this.processSceneGeometry(pass);
        pass.end();
    }

    private configureRenderState(pass: GPURenderPassEncoder) {
        pass.setPipeline(this.pipelineResources.renderPipeline);
        pass.setBindGroup(shaders.constants.bindGroup_scene, this.pipelineResources.renderBindGroup);
    }

    private processSceneGeometry(pass: GPURenderPassEncoder) {
        this.scene.iterate(
            node => pass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup),
            material => pass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup),
            primitive => {
                pass.setVertexBuffer(0, primitive.vertexBuffer);
                pass.setIndexBuffer(primitive.indexBuffer, 'uint32');
                pass.drawIndexed(primitive.numIndices);
            }
        );
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();

        // 1. Cluster with updated positions
        this.executeComputePhase(encoder);

        // 2. Then render with correct clustering
        this.executeRenderPhase(encoder);

        // Submit everything together
        renderer.device.queue.submit([encoder.finish()]);
    }
}