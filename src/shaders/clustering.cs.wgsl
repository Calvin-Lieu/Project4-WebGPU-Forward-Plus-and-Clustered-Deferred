@group(0) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(0) @binding(1) var<storage, read> lightSet: LightSet;
@group(0) @binding(2) var<storage, read_write> tileSet: TileSet;
@group(0) @binding(3) var<storage, read_write> tileLightIndices: TileLightIndices;

struct SpatialBounds {
    minCorner: vec3f,
    maxCorner: vec3f
}

struct TileCoordinates {
    x: u32,
    y: u32, 
    z: u32
}

fn calculateTileCoordinates(globalIndex: u32) -> TileCoordinates {
    let tilesPerLayer = u32(cameraUniforms.tilesX) * u32(cameraUniforms.tilesY);
    let z = globalIndex / tilesPerLayer;
    let xyIndex = globalIndex % tilesPerLayer;
    let y = xyIndex / u32(cameraUniforms.tilesX);
    let x = xyIndex % u32(cameraUniforms.tilesX);
    
    return TileCoordinates(x, y, z);
}

fn computeFlatIndex(coords: TileCoordinates) -> u32 {
    return coords.z * u32(cameraUniforms.tilesX) * u32(cameraUniforms.tilesY) + 
           coords.y * u32(cameraUniforms.tilesX) + coords.x;
}

fn transformScreenToViewSpace(screenCoord: vec2f, depth: f32) -> vec3f {
    let ndcCoord = vec2f(
        screenCoord.x * 2.0 - 1.0,
        (1.0 - screenCoord.y) * 2.0 - 1.0  
    );
    
    let aspectRatio = cameraUniforms.screenWidth / cameraUniforms.screenHeight;
    let fovTangent = 0.4142135623730951; 
    let horizontalTangent = fovTangent * aspectRatio;
    
    return vec3f(
        ndcCoord.x * horizontalTangent * depth,
        ndcCoord.y * fovTangent * depth,
        -depth
    );
}

fn calculateDepthRange(zTile: u32) -> vec2f {
    let depthScale = log(cameraUniforms.farPlane / cameraUniforms.nearPlane) / cameraUniforms.tilesZ;
    let nearDepth = cameraUniforms.nearPlane * exp(f32(zTile) * depthScale);
    let farDepth = cameraUniforms.nearPlane * exp(f32(zTile + 1) * depthScale);
    
    return vec2f(nearDepth, farDepth);
}

fn buildTileBounds(coords: TileCoordinates) -> SpatialBounds {
    let screenExtents = vec4f(
        f32(coords.x) / cameraUniforms.tilesX,
        f32(coords.y) / cameraUniforms.tilesY,
        f32(coords.x + 1) / cameraUniforms.tilesX,
        f32(coords.y + 1) / cameraUniforms.tilesY
    );
    
    let depthRange = calculateDepthRange(coords.z);
    
    // Calculate all frustum corners in view space
    let nearCorners = array<vec3f, 4>(
        transformScreenToViewSpace(screenExtents.xy, depthRange.x),
        transformScreenToViewSpace(vec2f(screenExtents.z, screenExtents.y), depthRange.x),
        transformScreenToViewSpace(vec2f(screenExtents.x, screenExtents.w), depthRange.x),
        transformScreenToViewSpace(screenExtents.zw, depthRange.x)
    );
    
    let farCorners = array<vec3f, 4>(
        transformScreenToViewSpace(screenExtents.xy, depthRange.y),
        transformScreenToViewSpace(vec2f(screenExtents.z, screenExtents.y), depthRange.y),
        transformScreenToViewSpace(vec2f(screenExtents.x, screenExtents.w), depthRange.y),
        transformScreenToViewSpace(screenExtents.zw, depthRange.y)
    );
    
    var bounds = SpatialBounds(nearCorners[0], nearCorners[0]);
    
    // Find AABB that encompasses all corners
    for (var i: u32 = 0; i < 4; i++) {
        bounds.minCorner = min(bounds.minCorner, nearCorners[i]);
        bounds.maxCorner = max(bounds.maxCorner, nearCorners[i]);
        bounds.minCorner = min(bounds.minCorner, farCorners[i]);
        bounds.maxCorner = max(bounds.maxCorner, farCorners[i]);
    }
    
    return bounds;
}

fn testSphereAABBIntersection(sphereCenter: vec3f, sphereRadius: f32, bounds: SpatialBounds) -> bool {
    let closestPoint = clamp(sphereCenter, bounds.minCorner, bounds.maxCorner);
    let distanceVector = sphereCenter - closestPoint;
    let distanceSquared = dot(distanceVector, distanceVector);
    
    return distanceSquared <= (sphereRadius * sphereRadius);
}

fn processLightAssignment(coords: TileCoordinates, bounds: SpatialBounds) -> u32 {
    let tileIndex = computeFlatIndex(coords);
    let lightRadius = f32(${lightRadius});
    var lightCount: u32 = 0;
    let baseOffset = tileIndex * ${maxLightsPerTile};
    
    for (var lightIdx: u32 = 0; lightIdx < lightSet.numLights && lightCount < ${maxLightsPerTile}; lightIdx++) {
        let worldLightPos = lightSet.lights[lightIdx].pos;
        let viewLightPos = (cameraUniforms.viewMat * vec4f(worldLightPos, 1.0)).xyz;
        
        if (testSphereAABBIntersection(viewLightPos, lightRadius, bounds)) {
            tileLightIndices.lightIndices[baseOffset + lightCount] = lightIdx;
            lightCount++;
        }
    }
    
    return lightCount;
}

@compute @workgroup_size(${tileWorkgroupSize})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let tileIndex = globalId.x;
    let maxTiles = u32(cameraUniforms.tilesX) * u32(cameraUniforms.tilesY) * u32(cameraUniforms.tilesZ);
    
    if (tileIndex >= maxTiles) {
        return;
    }
    
    let tileCoords = calculateTileCoordinates(tileIndex);
    let tileBounds = buildTileBounds(tileCoords);
    let assignedLights = processLightAssignment(tileCoords, tileBounds);
    
    let lightOffset = tileIndex * ${maxLightsPerTile};
    tileSet.tileLightData[tileIndex] = TileLightData(assignedLights, lightOffset, 0, 0);
}
