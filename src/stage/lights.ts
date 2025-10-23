import { vec3 } from "wgpu-matrix";
import { device } from "../renderer";
import * as shaders from '../shaders/shaders';
import { Camera } from "./camera";

// h in [0, 1]
function hueToRgb(h: number) {
    let f = (n: number, k = (n + h * 6) % 6) => 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    return vec3.lerp(vec3.create(1, 1, 1), vec3.create(f(5), f(3), f(1)), 0.8);
}

export class Lights {
    private camera: Camera;

    numLights = 500;
    static readonly maxNumLights = 5000;
    static readonly numFloatsPerLight = 8; // vec3f is aligned at 16 byte boundaries

    static readonly lightIntensity = 0.1;

    lightsArray = new Float32Array(Lights.maxNumLights * Lights.numFloatsPerLight);
    lightSetStorageBuffer: GPUBuffer;

    timeUniformBuffer: GPUBuffer;

    moveLightsComputeBindGroupLayout: GPUBindGroupLayout;
    moveLightsComputeBindGroup: GPUBindGroup;
    moveLightsComputePipeline: GPUComputePipeline;

    // Tile clustering infrastructure for Forward+ rendering
    tileClusterBuffer!: GPUBuffer;
    tileClusterIndicesBuffer!: GPUBuffer;
    tileClusteringBindGroupLayout!: GPUBindGroupLayout;
    tileClusteringBindGroup!: GPUBindGroup;
    tileClusteringPipeline!: GPUComputePipeline;

    constructor(camera: Camera) {
        this.camera = camera;

        this.lightSetStorageBuffer = device.createBuffer({
            label: "lights",
            size: 16 + this.lightsArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.populateLightsBuffer();
        this.updateLightSetUniformNumLights();

        this.timeUniformBuffer = device.createBuffer({
            label: "time uniform",
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.moveLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "move lights compute bind group layout",
            entries: [
                { // lightSet
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // time
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                }
            ]
        });

        this.moveLightsComputeBindGroup = device.createBindGroup({
            label: "move lights compute bind group",
            layout: this.moveLightsComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.lightSetStorageBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.timeUniformBuffer }
                }
            ]
        });

        this.moveLightsComputePipeline = device.createComputePipeline({
            label: "move lights compute pipeline",
            layout: device.createPipelineLayout({
                label: "move lights compute pipeline layout",
                bindGroupLayouts: [this.moveLightsComputeBindGroupLayout]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "move lights compute shader",
                    code: shaders.moveLightsComputeSrc
                }),
                entryPoint: "main"
            }
        });

        this.initializeTileClustering();
    }

    private initializeTileClustering() {
        const totalTiles = shaders.constants.tilesX * shaders.constants.tilesY * shaders.constants.tilesZ;
        const tileDataSize = 16; // TileLightData struct size
        const maxLightIndices = totalTiles * shaders.constants.maxLightsPerTile;

        this.tileClusterBuffer = device.createBuffer({
            label: "tile cluster data",
            size: 4 + (totalTiles * tileDataSize), // 4 bytes for numTiles + tile data
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.tileClusterIndicesBuffer = device.createBuffer({
            label: "tile cluster light indices",
            size: maxLightIndices * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.tileClusteringBindGroupLayout = device.createBindGroupLayout({
            label: "tile clustering bind group layout",
            entries: [
                {
                    binding: 0, // Camera uniforms
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1, // Light set
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 2, // Tile data output
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
                {
                    binding: 3, // Tile light indices output
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                }
            ],
        });

        this.tileClusteringBindGroup = device.createBindGroup({
            label: "tile clustering bind group",
            layout: this.tileClusteringBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.camera.getUniformsBuffer() },
                },
                {
                    binding: 1,
                    resource: { buffer: this.lightSetStorageBuffer },
                },
                {
                    binding: 2,
                    resource: { buffer: this.tileClusterBuffer },
                },
                {
                    binding: 3,
                    resource: { buffer: this.tileClusterIndicesBuffer },
                }
            ],
        });

        this.tileClusteringPipeline = device.createComputePipeline({
            label: "tile clustering pipeline",
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.tileClusteringBindGroupLayout],
            }),
            compute: {
                module: device.createShaderModule({
                    label: "tile clustering shader",
                    code: shaders.clusteringComputeSrc,
                }),
                entryPoint: "main",
            },
        });
    }

    private populateLightsBuffer() {
        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // light pos is set by compute shader so no need to set it here
            const lightColor = vec3.scale(hueToRgb(Math.random()), Lights.lightIntensity);
            this.lightsArray.set(lightColor, (lightIdx * Lights.numFloatsPerLight) + 4);
        }

        device.queue.writeBuffer(this.lightSetStorageBuffer, 16, this.lightsArray);
    }

    updateLightSetUniformNumLights() {
        device.queue.writeBuffer(this.lightSetStorageBuffer, 0, new Uint32Array([this.numLights]));
    }

    doLightClustering(encoder: GPUCommandEncoder) {
        const computePass = encoder.beginComputePass({ label: "tile light clustering" });
        computePass.setPipeline(this.tileClusteringPipeline);
        computePass.setBindGroup(0, this.tileClusteringBindGroup);

        const totalTiles = shaders.constants.tilesX * shaders.constants.tilesY * shaders.constants.tilesZ;
        const workgroupCount = Math.ceil(totalTiles / shaders.constants.tileWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
    }

    // CHECKITOUT: this is where the light movement compute shader is dispatched from the host
    onFrame(time: number) {
        device.queue.writeBuffer(this.timeUniformBuffer, 0, new Float32Array([time]));

        // not using same encoder as render pass so this doesn't interfere with measuring actual rendering performance
        const encoder = device.createCommandEncoder();

        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.moveLightsComputePipeline);

        computePass.setBindGroup(0, this.moveLightsComputeBindGroup);

        const workgroupCount = Math.ceil(this.numLights / shaders.constants.moveLightsWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);

        computePass.end();

        device.queue.submit([encoder.finish()]);
    }
}