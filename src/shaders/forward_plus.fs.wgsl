const X_SLICES : u32 = ${X_SLICES}u;
const Y_SLICES : u32 = ${Y_SLICES}u;
const Z_SLICES : u32 = ${Z_SLICES}u;
const MAX_LIGHTS_PER_CLUSTER : u32 = ${MAX_LIGHTS_PER_CLUSTER}u;

struct Cluster {
    count   : u32,
    _pad1   : u32,
    _pad2   : u32,
    _pad3   : u32,
    indices : array<u32, MAX_LIGHTS_PER_CLUSTER>,
};

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(0) @binding(1) var<storage, read> lightSet : LightSet;
@group(0) @binding(2) var<storage, read> clusters : array<Cluster>;

@group(${bindGroup_material}) @binding(0) var baseColorTex : texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var baseColorSampler : sampler;

fn getClusterIndex(fragCoord : vec4f, worldPos : vec3f) -> u32 {
    // Screen space calculation
    let screenX = fragCoord.x / camera.screenDimensions.x;
    let screenY = fragCoord.y / camera.screenDimensions.y;

    let xSlice = clamp(u32(screenX * f32(X_SLICES)), 0u, X_SLICES - 1u);
    let ySlice = clamp(u32(screenY * f32(Y_SLICES)), 0u, Y_SLICES - 1u);

    // Transform world position to view space for depth
    let viewPos = (camera.viewMat * vec4f(worldPos, 1.0)).xyz;
    let depth = -viewPos.z;  // View space depth (positive)
    
    // Use logarithmic depth slicing (same as compute shader)
    let near = camera.nearPlane;
    let far = camera.farPlane;
    let depthSliceScale = log(far / near) / f32(Z_SLICES);
    
    // Find which logarithmic slice this depth falls into
    let normalizedLogDepth = log(depth / near) / log(far / near);
    let zSlice = clamp(u32(normalizedLogDepth * f32(Z_SLICES)), 0u, Z_SLICES - 1u);

    return xSlice + ySlice * X_SLICES + zSlice * (X_SLICES * Y_SLICES);
}

@fragment
fn main(
    @location(0) inWorldPos : vec3f,
    @location(1) inNormal   : vec3f,
    @location(2) inUV       : vec2f,
    @builtin(position) fragCoord : vec4f
) -> @location(0) vec4f {
    let baseColor = textureSample(baseColorTex, baseColorSampler, inUV);
    if (baseColor.a < 0.5f) {
        discard;
    }
    
    let clusterIndex = getClusterIndex(fragCoord, inWorldPos);
    let cluster = clusters[clusterIndex];

    var totalLight = vec3f(0.1, 0.1, 0.1);
    
    let lightCount = cluster.count;
    for (var i : u32 = 0u; i < lightCount; i = i + 1u) {
        let lightIndex = cluster.indices[i];
        let light = lightSet.lights[lightIndex];

        totalLight += calculateLightContrib(light, inWorldPos, normalize(inNormal));
    }

    let finalColor = baseColor.rgb * totalLight;
    return vec4(finalColor, 1);
}
