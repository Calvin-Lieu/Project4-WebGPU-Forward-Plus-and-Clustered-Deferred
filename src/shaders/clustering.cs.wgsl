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
@group(0) @binding(2) var<storage, read_write> clusters : array<Cluster>;
// @group(0) @binding(3) var<storage, read_write> debugCounts : array<u32>;

fn flatten_index(x: u32, y: u32, z: u32) -> u32 {
    return x + y * X_SLICES + z * (X_SLICES * Y_SLICES);
}

// Convert screen coordinates to view space 
fn screenToViewSpace(screenCoord: vec2f, depth: f32) -> vec3f {
    // Convert screen [0,1] to NDC [-1,1]
    let ndc = vec2f(
        screenCoord.x * 2.0 - 1.0,
        (1.0 - screenCoord.y) * 2.0 - 1.0  // Flip Y for correct orientation
    );
    
    // Calculate FOV parameters 
    let aspectRatio = camera.screenDimensions.x / camera.screenDimensions.y;
    let tanHalfFovY = 0.4142135623730951; // tan(22.5 degrees) for 45-degree FOV
    let tanHalfFovX = tanHalfFovY * aspectRatio;
    
    // Convert NDC to view space
    return vec3f(
        ndc.x * tanHalfFovX * depth,
        ndc.y * tanHalfFovY * depth,
        -depth  // Negative Z in view space
    );
}

fn sphere_intersects_aabb(center: vec3f, radius: f32, min: vec3f, max: vec3f) -> bool {
    var d: f32 = 0.0;
    for (var i: u32 = 0u; i < 3u; i = i + 1u) {
        let p = select(center[i] - max[i], select(0.0, min[i] - center[i], center[i] < min[i]), center[i] > max[i]);
        d += p * p;
    }
    return d <= radius * radius;
}

@compute @workgroup_size(1, 1, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= X_SLICES || gid.y >= Y_SLICES || gid.z >= Z_SLICES) { return; }

    let clusterIndex = flatten_index(gid.x, gid.y, gid.z);
    clusters[clusterIndex].count = 0u;

    let near = camera.nearPlane;
    let far = camera.farPlane;
    
    // Logarithmic depth slicing
    let depthSliceScale = log(far / near) / f32(Z_SLICES);
    let clusterDepthNear = near * exp(f32(gid.z) * depthSliceScale);
    let clusterDepthFar = near * exp(f32(gid.z + 1) * depthSliceScale);

    // Screen space bounds for this cluster
    let clusterMinScreen = vec2f(
        f32(gid.x) / f32(X_SLICES), 
        f32(gid.y) / f32(Y_SLICES)
    );
    let clusterMaxScreen = vec2f(
        f32(gid.x + 1) / f32(X_SLICES), 
        f32(gid.y + 1) / f32(Y_SLICES)
    );
    
    // Calculate all 8 corners of the cluster frustum
    let corner1 = screenToViewSpace(clusterMinScreen, clusterDepthNear);
    let corner2 = screenToViewSpace(vec2f(clusterMaxScreen.x, clusterMinScreen.y), clusterDepthNear);
    let corner3 = screenToViewSpace(vec2f(clusterMinScreen.x, clusterMaxScreen.y), clusterDepthNear);
    let corner4 = screenToViewSpace(clusterMaxScreen, clusterDepthNear);
    let corner5 = screenToViewSpace(clusterMinScreen, clusterDepthFar);
    let corner6 = screenToViewSpace(vec2f(clusterMaxScreen.x, clusterMinScreen.y), clusterDepthFar);
    let corner7 = screenToViewSpace(vec2f(clusterMinScreen.x, clusterMaxScreen.y), clusterDepthFar);
    let corner8 = screenToViewSpace(clusterMaxScreen, clusterDepthFar);
    
    // Find bounding box that encompasses all corners
    var clusterMin = min(min(min(corner1, corner2), min(corner3, corner4)), 
                         min(min(corner5, corner6), min(corner7, corner8)));
    var clusterMax = max(max(max(corner1, corner2), max(corner3, corner4)), 
                         max(max(corner5, corner6), max(corner7, corner8)));

    // Transform lights to view space
    let lightRadius = f32(${lightRadius});

    for (var i: u32 = 0u; i < lightSet.numLights; i = i + 1u) {
        if (clusters[clusterIndex].count >= MAX_LIGHTS_PER_CLUSTER) { break; }

        let lightWorldPos = lightSet.lights[i].pos;
        // Transform light position to view space using view matrix
        let lightViewPos = (camera.viewMat * vec4f(lightWorldPos, 1.0)).xyz;
        
        if (sphere_intersects_aabb(lightViewPos, lightRadius, clusterMin, clusterMax)) {
            let idx = clusters[clusterIndex].count;
            clusters[clusterIndex].indices[idx] = i;
            clusters[clusterIndex].count = idx + 1u;
        }
    }
    
    // debugCounts[clusterIndex] = clusters[clusterIndex].count;
}
