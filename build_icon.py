"""Generate a crisp multi-resolution Windows .ico icon for XIQ-SE API Studio."""

from pathlib import Path
from PIL import Image, ImageDraw


def generate_icon(output_path: Path) -> None:
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded dark purple-indigo background badge (Extreme Networks inspired palette)
    draw.rounded_rectangle([(12, 12), (244, 244)], radius=54, fill=(18, 20, 42, 255))
    draw.rounded_rectangle([(18, 18), (238, 238)], radius=48, outline=(124, 58, 237, 255), width=6)

    # Subtle glowing inner ring
    draw.ellipse([(48, 48), (208, 208)], outline=(56, 189, 248, 90), width=4)

    # Network GraphQL hexagon + node links
    cx, cy = 128, 128
    nodes = [
        (128, 56),
        (190, 92),
        (190, 164),
        (128, 200),
        (66, 164),
        (66, 92),
    ]
    # Outer edges
    for i in range(len(nodes)):
        p1 = nodes[i]
        p2 = nodes[(i + 1) % len(nodes)]
        draw.line([p1, p2], fill=(139, 92, 246, 255), width=9)

    # Inner cross links to center
    for idx in (0, 2, 4):
        draw.line([(cx, cy), nodes[idx]], fill=(56, 189, 248, 255), width=7)

    # Draw outer nodes
    for x, y in nodes:
        draw.ellipse([(x - 14, y - 14), (x + 14, y + 14)], fill=(56, 189, 248, 255), outline=(18, 20, 42, 255), width=4)

    # Central glowing node
    draw.ellipse([(cx - 22, cy - 22), (cx + 22, cy + 22)], fill=(168, 85, 247, 255), outline=(255, 255, 255, 255), width=5)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(
        output_path,
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    print(f"Icon saved to {output_path}")


if __name__ == "__main__":
    generate_icon(Path(__file__).resolve().parent / "assets" / "app_icon.ico")
