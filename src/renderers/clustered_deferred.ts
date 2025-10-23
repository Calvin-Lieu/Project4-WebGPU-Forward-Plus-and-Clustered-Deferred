import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

interface GBufferTextures {
    positionTexture: GPUTexture;
    albedoTexture: GPUTexture;
    normalTexture: GPUTexture;
    depthTexture: GPUTexture;
    positionView: GPUTextureView;
    albedoView: GPUTextureView;
    normalView: GPUTextureView;
    depthView: GPUTextureView;
}

interface ClusteringResources {
    spatialDataBuffer: GPUBuffer;
    spatialIndicesBuffer: GPUBuffer;
    clusteringLayout: GPUBindGroupLayout;
    clusteringBindGroup: GPUBindGroup;
    clusteringPipeline: GPUComputePipeline;
}

interface GeometryPipelineResources {
    layout: GPUBindGroupLayout;
    bindGroup: GPUBindGroup;
    pipeline: GPURenderPipeline;
}

interface FullscreenPipelineResources {
    layout: GPUBindGroupLayout;
    bindGroup: GPUBindGroup;
    pipeline: GPURenderPipeline;
    sampler: GPUSampler;
}

export class ClusteredDeferredRenderer extends renderer.Renderer {
    private gBufferTextures: GBufferTextures;
    private clusteringResources: ClusteringResources;
    private geometryPipeline: GeometryPipelineResources;
    private fullscreenPipeline: FullscreenPipelineResources;

    constructor(stage: Stage) {
        super(stage);

        this.gBufferTextures = this.createGBufferTextures();
        this.clusteringResources = this.initializeClusteringSystem();
        this.geometryPipeline = this.buildGeometryPipeline();
        this.fullscreenPipeline = this.buildFullscreenPipeline();
    }

    private createGBufferTextures(): GBufferTextures {
        const baseSize = [renderer.canvas.width, renderer.canvas.height];
        const baseUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

        const positionTexture = renderer.device.createTexture({
            size: baseSize,
            usage: baseUsage,
            format: 'rgba16float', // Store world position
            label: 'G-buffer position'
        });

        const albedoTexture = renderer.device.createTexture({
            size: baseSize,
            usage: baseUsage,
            format: 'rgba8unorm', // Store diffuse color
            label: 'G-buffer albedo'
        });

        const normalTexture = renderer.device.createTexture({
            size: baseSize,
            usage: baseUsage,
            format: 'rgba16float', // Store world normal
            label: 'G-buffer normal'
        });

        const depthTexture = renderer.device.createTexture({
            size: baseSize,
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            label: 'G-buffer depth'
        });

        return {
            positionTexture,
            albedoTexture,
            normalTexture,
            depthTexture,
            positionView: positionTexture.createView(),
            albedoView: albedoTexture.createView(),
            normalView: normalTexture.createView(),
            depthView: depthTexture.createView()
        };
    }

    private initializeClusteringSystem(): ClusteringResources {
        const totalSpatialTiles = shaders.constants.tilesX * shaders.constants.tilesY * shaders.constants.tilesZ;
        const spatialDataStride = 16;
        const maxSpatialIndices = totalSpatialTiles * shaders.constants.maxLightsPerTile;

        const spatialDataBuffer = renderer.device.createBuffer({
            label: "deferred spatial data buffer",
            size: 4 + (totalSpatialTiles * spatialDataStride),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        const spatialIndicesBuffer = renderer.device.createBuffer({
            label: "deferred spatial indices buffer",
            size: maxSpatialIndices * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        const clusteringLayout = renderer.device.createBindGroupLayout({
            label: "deferred clustering layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
            ]
        });

        const clusteringBindGroup = renderer.device.createBindGroup({
            label: "deferred clustering group",
            layout: clusteringLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: spatialDataBuffer } },
                { binding: 3, resource: { buffer: spatialIndicesBuffer } }
            ]
        });

        const clusteringPipeline = renderer.device.createComputePipeline({
            label: "deferred clustering pipeline",
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [clusteringLayout] }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "deferred clustering compute",
                    code: shaders.clusteringComputeSrc
                }),
                entryPoint: "main"
            }
        });

        return {
            spatialDataBuffer,
            spatialIndicesBuffer,
            clusteringLayout,
            clusteringBindGroup,
            clusteringPipeline
        };
    }

    private buildGeometryPipeline(): GeometryPipelineResources {
        const layout = renderer.device.createBindGroupLayout({
            label: "geometry pass layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }
            ]
        });

        const bindGroup = renderer.device.createBindGroup({
            label: "geometry pass group",
            layout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } }
            ]
        });

        const pipeline = renderer.device.createRenderPipeline({
            label: "geometry pass pipeline",
            layout: renderer.device.createPipelineLayout({
                bindGroupLayouts: [layout, renderer.modelBindGroupLayout, renderer.materialBindGroupLayout]
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "geometry vertex module",
                    code: shaders.naiveVertSrc
                }),
                buffers: [renderer.vertexBufferLayout]
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "geometry fragment module",
                    code: shaders.clusteredDeferredFragSrc
                }),
                targets: [
                    { format: 'rgba16float' }, // Position
                    { format: 'rgba8unorm' },   // Albedo
                    { format: 'rgba16float' }   // Normal
                ]
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less'
            }
        });

        return { layout, bindGroup, pipeline };
    }

    private buildFullscreenPipeline(): FullscreenPipelineResources {
        const sampler = renderer.device.createSampler({
            label: "G-buffer sampler",
            minFilter: 'nearest',
            magFilter: 'nearest'
        });

        const layout = renderer.device.createBindGroupLayout({
            label: "fullscreen pass layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // Position
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // Albedo
                { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // Normal
                { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
            ]
        });

        const bindGroup = renderer.device.createBindGroup({
            label: "fullscreen pass group",
            layout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusteringResources.spatialDataBuffer } },
                { binding: 3, resource: { buffer: this.clusteringResources.spatialIndicesBuffer } },
                { binding: 4, resource: this.gBufferTextures.positionView },
                { binding: 5, resource: this.gBufferTextures.albedoView },
                { binding: 6, resource: this.gBufferTextures.normalView },
                { binding: 7, resource: sampler }
            ]
        });

        const pipeline = renderer.device.createRenderPipeline({
            label: "fullscreen pass pipeline",
            layout: renderer.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "fullscreen vertex module",
                    code: shaders.clusteredDeferredFullscreenVertSrc
                })
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "fullscreen fragment module",
                    code: shaders.clusteredDeferredFullscreenFragSrc
                }),
                targets: [{ format: renderer.canvasFormat }]
            }
        });

        return { layout, bindGroup, pipeline, sampler };
    }

    private executeSpatialClustering(encoder: GPUCommandEncoder) {
        const pass = encoder.beginComputePass({ label: "deferred spatial clustering" });
        pass.setPipeline(this.clusteringResources.clusteringPipeline);
        pass.setBindGroup(0, this.clusteringResources.clusteringBindGroup);

        const totalTiles = shaders.constants.tilesX * shaders.constants.tilesY * shaders.constants.tilesZ;
        const workgroupCount = Math.ceil(totalTiles / shaders.constants.tileWorkgroupSize);
        pass.dispatchWorkgroups(workgroupCount);
        pass.end();
    }

    private executeGeometryPass(encoder: GPUCommandEncoder) {
        const pass = encoder.beginRenderPass({
            label: "G-buffer geometry pass",
            colorAttachments: [
                {
                    view: this.gBufferTextures.positionView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store'
                },
                {
                    view: this.gBufferTextures.albedoView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store'
                },
                {
                    view: this.gBufferTextures.normalView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store'
                }
            ],
            depthStencilAttachment: {
                view: this.gBufferTextures.depthView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store'
            }
        });

        pass.setPipeline(this.geometryPipeline.pipeline);
        pass.setBindGroup(0, this.geometryPipeline.bindGroup);

        this.scene.iterate(
            node => pass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup),
            material => pass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup),
            primitive => {
                pass.setVertexBuffer(0, primitive.vertexBuffer);
                pass.setIndexBuffer(primitive.indexBuffer, 'uint32');
                pass.drawIndexed(primitive.numIndices);
            }
        );

        pass.end();
    }

    private executeFullscreenPass(encoder: GPUCommandEncoder) {
        const canvasView = renderer.context.getCurrentTexture().createView();
        const pass = encoder.beginRenderPass({
            label: "deferred lighting pass",
            colorAttachments: [{
                view: canvasView,
                clearValue: [0, 0, 0, 1],
                loadOp: 'clear',
                storeOp: 'store'
            }]
        });

        pass.setPipeline(this.fullscreenPipeline.pipeline);
        pass.setBindGroup(0, this.fullscreenPipeline.bindGroup);
        pass.draw(3); // Fullscreen triangle

        pass.end();
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();

        this.executeSpatialClustering(encoder);
        this.executeGeometryPass(encoder);
        this.executeFullscreenPass(encoder);

        renderer.device.queue.submit([encoder.finish()]);
    }
}