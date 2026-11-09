# Media - Image Transformations

## Usage examples

### 1. On-the-fly transformation

```
GET /api/media/transform/:id?w=800&h=600&fit=cover&f=webp&q=85
```

**Parameters:**

| Parameter         | Description                                      | Example      |
| ----------------- | ------------------------------------------------ | ------------ |
| `w`, `width`      | Target width                                     | `w=800`      |
| `h`, `height`     | Target height                                    | `h=600`      |
| `fit`             | Fit mode (cover, contain, fill, inside, outside) | `fit=cover`  |
| `pos`, `position` | Crop position (center, top, right, bottom, left) | `pos=center` |
| `f`, `format`     | Output format (jpeg, png, webp, avif)            | `f=webp`     |
| `q`, `quality`    | Quality 1-100                                    | `q=85`       |
| `fp`              | Focal point (format: "x,y", each 0-1)            | `fp=0.5,0.3` |

### 2. Presets

```
GET /api/media/preset/:id/thumbnail
GET /api/media/preset/:id/small
GET /api/media/preset/:id/medium
GET /api/media/preset/:id/large
GET /api/media/preset/:id/hero
```

**Available presets:**

| Preset      | Dimensions | Typical use         |
| ----------- | ---------- | ------------------- |
| `thumbnail` | 150x150    | Avatars, icons      |
| `small`     | 400x300    | Previews, galleries |
| `medium`    | 800x600    | Main content        |
| `large`     | 1200x800   | Featured images     |
| `hero`      | 1920x1080  | Banners, headers    |

### 3. Focal point (smart cropping)

**Set the focal point:**

```bash
POST /api/media/focal-point/:id
Content-Type: application/json

{
  "x": 0.5,  // 0 = left, 1 = right
  "y": 0.3   // 0 = top, 1 = bottom
}
```

**Read the focal point:**

```bash
GET /api/media/focal-point/:id
```

**Use with a transformation:**

```
GET /api/media/transform/:id?w=400&h=400&fit=cover
```

If the asset has a focal point, the crop uses it automatically.

### 4. HTML examples

```html
<!-- Thumbnail with a preset -->
<img src="/api/media/preset/123/thumbnail" alt="Thumbnail" />

<!-- Responsive image with srcset -->
<img
  src="/api/media/preset/123/medium"
  srcset="
    /api/media/preset/123/small   400w,
    /api/media/preset/123/medium  800w,
    /api/media/preset/123/large  1200w
  "
  sizes="(max-width: 600px) 400px, (max-width: 1000px) 800px, 1200px"
  alt="Responsive image"
/>

<!-- WebP with fallback -->
<picture>
  <source srcset="/api/media/transform/123?w=800&f=webp" type="image/webp" />
  <img src="/api/media/transform/123?w=800&f=jpeg" alt="WebP with fallback" />
</picture>
```

### 5. Cache and performance

- Transformations are cached in storage after the first time they are generated
- Cache header: `Cache-Control: public, max-age=31536000, immutable` (1 year)
- URLs are deterministic (same parameters = same URL)

### 6. Clearing the cache

```bash
DELETE /api/media/cache/:id
```

Removes every transformation generated for an asset.

## Installation

```bash
# Install sharp
bun install sharp

# Run migrations
kitsuden migrate
```

## Configuration

Media includes image transformation out of the box. It needs no extra configuration.
