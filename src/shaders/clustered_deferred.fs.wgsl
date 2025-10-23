@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

struct GBufferOutput {
    @location(0) position: vec4f,
    @location(1) albedo: vec4f,
    @location(2) normal: vec4f
}

@fragment
fn main(in: FragmentInput) -> GBufferOutput {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    
    if (diffuseColor.a < 0.5f) {
        discard;
    }
    
    var output: GBufferOutput;
    
    // Store world position in first render target
    output.position = vec4f(in.pos, 1.0);
    
    // Store albedo/diffuse color in second render target
    output.albedo = diffuseColor;
    
    // Store world normal in third render target
    output.normal = vec4f(normalize(in.nor), 1.0);
    
    return output;
}
