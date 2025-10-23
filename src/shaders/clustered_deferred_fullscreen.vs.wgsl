struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) texCoord: vec2f
}

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    
    // Generate fullscreen triangle using vertex index
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
    
    output.position = vec4f(x, y, 0.0, 1.0);
    output.texCoord = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    
    return output;
}
