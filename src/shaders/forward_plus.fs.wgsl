@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> tileSet: TileSet;
@group(${bindGroup_scene}) @binding(3) var<storage, read> tileLightIndices: TileLightIndices;

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

struct ScreenSpaceInfo {
    normalizedCoords: vec2f,
    viewSpaceDepth: f32
}

struct SpatialIndex {
    tileCoords: vec3u,
    flatIndex: u32
}

fn extractScreenSpaceInfo(fragmentPos: vec4f, worldPos: vec3f) -> ScreenSpaceInfo {
    let screenCoords = vec2f(
        fragmentPos.x / cameraUniforms.screenWidth,
        fragmentPos.y / cameraUniforms.screenHeight
    );
    
    let viewSpacePos = (cameraUniforms.viewMat * vec4f(worldPos, 1.0)).xyz;
    let depth = -viewSpacePos.z;
    
    return ScreenSpaceInfo(screenCoords, depth);
}

fn mapToSpatialGrid(screenInfo: ScreenSpaceInfo) -> vec3u {
    let gridX = u32(clamp(screenInfo.normalizedCoords.x * cameraUniforms.tilesX, 0.0, cameraUniforms.tilesX - 1.0));
    let gridY = u32(clamp(screenInfo.normalizedCoords.y * cameraUniforms.tilesY, 0.0, cameraUniforms.tilesY - 1.0));
    
    let depthRange = clamp(screenInfo.viewSpaceDepth, cameraUniforms.nearPlane, cameraUniforms.farPlane);
    let logNormalizedDepth = log(depthRange / cameraUniforms.nearPlane) / log(cameraUniforms.farPlane / cameraUniforms.nearPlane);
    let gridZ = u32(clamp(logNormalizedDepth * cameraUniforms.tilesZ, 0.0, cameraUniforms.tilesZ - 1.0));
    
    return vec3u(gridX, gridY, gridZ);
}

fn calculateSpatialIndex(gridCoords: vec3u) -> u32 {
    return gridCoords.z * u32(cameraUniforms.tilesX) * u32(cameraUniforms.tilesY) + 
           gridCoords.y * u32(cameraUniforms.tilesX) + gridCoords.x;
}

fn resolveSpatialIndex(screenInfo: ScreenSpaceInfo) -> SpatialIndex {
    let gridCoords = mapToSpatialGrid(screenInfo);
    let flatIndex = calculateSpatialIndex(gridCoords);
    return SpatialIndex(gridCoords, flatIndex);
}

fn calculateLightingContribution(worldPos: vec3f, normal: vec3f, spatialIndex: SpatialIndex) -> vec3f {
    let maxTiles = arrayLength(&tileSet.tileLightData);
    if (spatialIndex.flatIndex >= maxTiles) {
        return vec3f(0.1, 0.1, 0.1); // Return ambient only if tile index is invalid
    }
    
    let lightData = tileSet.tileLightData[spatialIndex.flatIndex];
    var accumulatedLighting = vec3f(0.1, 0.1, 0.1); // Ambient contribution
    
    let lightStartIndex = lightData.lightStartOffset;
    let lightCount = min(lightData.lightCount, ${maxLightsPerTile}); // Cap to prevent overflow
    let maxLightIndices = arrayLength(&tileLightIndices.lightIndices);
    let maxLights = arrayLength(&lightSet.lights);
    
    for (var lightIdx = 0u; lightIdx < lightCount; lightIdx++) {
        let globalIndexLocation = lightStartIndex + lightIdx;
        
        if (globalIndexLocation >= maxLightIndices) {
            break; // Stop processing if we're beyond the array bounds
        }
        
        let globalLightIndex = tileLightIndices.lightIndices[globalIndexLocation];
        
        if (globalLightIndex >= maxLights) {
            continue; // Skip invalid light indices
        }
        
        let currentLight = lightSet.lights[globalLightIndex];
        let lightContribution = calculateLightContrib(currentLight, worldPos, normal);
        accumulatedLighting += lightContribution;
    }
    
    return accumulatedLighting;
}

fn combineColorAndLighting(baseColor: vec4f, lightingResult: vec3f) -> vec4f {
    let finalColor = baseColor.rgb * lightingResult;
    return vec4(finalColor, 1.0);
}

@fragment
fn main(in: FragmentInput, @builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
    let materialColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    
    if (materialColor.a < 0.5f) {
        discard;
    }
    
    let screenInfo = extractScreenSpaceInfo(fragCoord, in.pos);
    let spatialIndex = resolveSpatialIndex(screenInfo);
    let lightingResult = calculateLightingContribution(in.pos, normalize(in.nor), spatialIndex);
    
    return combineColorAndLighting(materialColor, lightingResult);
}
