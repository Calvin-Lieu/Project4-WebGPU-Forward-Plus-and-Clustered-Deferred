// CHECKITOUT: code that you add here will be prepended to all shaders

struct Light {
    pos: vec3f,
    color: vec3f
}

struct LightSet {
    numLights: u32,
    lights: array<Light>
}

struct TileLightData {
    lightCount: u32,
    lightStartOffset: u32,
    _padding1: u32,
    _padding2: u32
}

struct TileSet {
    numTiles: u32,
    tileLightData: array<TileLightData>
}

struct TileLightIndices {
    lightIndices: array<u32>
}

struct CameraUniforms {
    viewProjMat: mat4x4f,
    viewMat: mat4x4f,
    screenWidth: f32,
    screenHeight: f32,
    nearPlane: f32,
    farPlane: f32,
    tilesX: f32,
    tilesY: f32,
    tilesZ: f32,
    _padding1: f32
}

// CHECKITOUT: this special attenuation function ensures lights don't affect geometry outside the maximum light radius
fn rangeAttenuation(distance: f32) -> f32 {
    return clamp(1.f - pow(distance / ${lightRadius}, 4.f), 0.f, 1.f) / (distance * distance);
}

fn calculateLightContrib(light: Light, posWorld: vec3f, nor: vec3f) -> vec3f {
    let vecToLight = light.pos - posWorld;
    let distToLight = length(vecToLight);
    let lambert = max(dot(nor, normalize(vecToLight)), 0.f);
    return light.color * lambert * rangeAttenuation(distToLight);
}
