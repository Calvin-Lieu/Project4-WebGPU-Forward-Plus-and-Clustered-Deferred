@group(0) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(0) @binding(1) var<storage, read> lightSet: LightSet;
@group(0) @binding(2) var<storage, read> tileSet: TileSet;
@group(0) @binding(3) var<storage, read> tileLightIndices: TileLightIndices;
@group(0) @binding(4) var gBufferPosition: texture_2d<f32>;
@group(0) @binding(5) var gBufferAlbedo: texture_2d<f32>;
@group(0) @binding(6) var gBufferNormal: texture_2d<f32>;
@group(0) @binding(7) var gBufferSampler: sampler;

struct FullscreenInput {
    @builtin(position) position: vec4f,
    @location(0) texCoord: vec2f
}

struct LightingCalculation {
    worldPos: vec3f,
    albedo: vec3f,
    normal: vec3f
}

fn readGBufferData(texCoord: vec2f) -> LightingCalculation {
    let positionSample = textureSample(gBufferPosition, gBufferSampler, texCoord);
    let albedoSample = textureSample(gBufferAlbedo, gBufferSampler, texCoord);
    let normalSample = textureSample(gBufferNormal, gBufferSampler, texCoord);
    
    var data: LightingCalculation;
    data.worldPos = positionSample.xyz;
    data.albedo = albedoSample.rgb;
    data.normal = normalize(normalSample.xyz);
    
    return data;
}

fn calculateSpatialCoordinates(fragPos: vec4f, worldPos: vec3f) -> vec3u {
    // Use fragment screen coordinates directly
    let screenCoord = vec2f(
        fragPos.x / cameraUniforms.screenWidth,
        fragPos.y / cameraUniforms.screenHeight
    );
    
    // Transform world position to view space for depth calculation
    let viewSpacePos = (cameraUniforms.viewMat * vec4f(worldPos, 1.0)).xyz;
    let depth = -viewSpacePos.z;
    
    let spatialX = u32(clamp(screenCoord.x * cameraUniforms.tilesX, 0.0, cameraUniforms.tilesX - 1.0));
    let spatialY = u32(clamp(screenCoord.y * cameraUniforms.tilesY, 0.0, cameraUniforms.tilesY - 1.0));
    
    let depthRange = clamp(depth, cameraUniforms.nearPlane, cameraUniforms.farPlane);
    let logNormalizedDepth = log(depthRange / cameraUniforms.nearPlane) / log(cameraUniforms.farPlane / cameraUniforms.nearPlane);
    let spatialZ = u32(clamp(logNormalizedDepth * cameraUniforms.tilesZ, 0.0, cameraUniforms.tilesZ - 1.0));
    
    return vec3u(spatialX, spatialY, spatialZ);
}

fn flattenSpatialIndex(coords: vec3u) -> u32 {
    return coords.z * u32(cameraUniforms.tilesX) * u32(cameraUniforms.tilesY) + 
           coords.y * u32(cameraUniforms.tilesX) + coords.x;
}

fn accumulateClusteredLighting(data: LightingCalculation, fragPos: vec4f) -> vec3f {
    let spatialCoords = calculateSpatialCoordinates(fragPos, data.worldPos);
    let spatialIndex = flattenSpatialIndex(spatialCoords);
    
    let lightData = tileSet.tileLightData[spatialIndex];
    var finalLighting = vec3f(0.1, 0.1, 0.1);
    
    let lightStartOffset = lightData.lightStartOffset;
    let lightCount = lightData.lightCount;
    
    for (var lightIdx = 0u; lightIdx < lightCount; lightIdx++) {
        let globalLightIdx = tileLightIndices.lightIndices[lightStartOffset + lightIdx];
        let currentLight = lightSet.lights[globalLightIdx];
        
        let lightContribution = calculateLightContrib(currentLight, data.worldPos, data.normal);
        finalLighting += lightContribution;
    }
    
    return finalLighting;
}

@fragment
fn main(in: FullscreenInput) -> @location(0) vec4f {
    var lightingData = readGBufferData(in.texCoord);
    
    // Skip lighting calculation for background pixels
    if (length(lightingData.worldPos) < 0.001) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    
    let lightingResult = accumulateClusteredLighting(lightingData, in.position);
    let finalColor = lightingData.albedo * lightingResult;
    
    return vec4f(finalColor, 1.0);
}
