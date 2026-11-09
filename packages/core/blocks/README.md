# Kon Blocks — Page Builder

Lego-style block system for dynamic page layouts with JSON Drag & Drop support.

## Features

- **12 Block Types**: Hero, Text, Image, Video, Grid, Cards, Quote, CTA, Embed, Divider, Spacer, Custom
- **Drag & Drop**: Reorder blocks with sort order positioning
- **Block Templates**: Save and reuse block configurations
- **Visibility Scheduling**: Show/hide blocks based on dates
- **SEO Ready**: Per-page meta titles, descriptions, and OG images
- **Responsive Grid**: 12-column layout system
- **Public Render API**: Fast endpoint for consuming pages
- **Responsive Images**: Automatic transform URLs for media blocks (requires kon-media)
- **Focal Point Cropping**: Smart cropping for Hero backgrounds

## Quick Start

### Create a Page

```bash
POST /api/page-builder/pages
{
  "title": "Homepage",
  "slug": "home",
  "layout": "default",
  "status": "published",
  "blocks": [
    {
      "type": "hero",
      "content": {
        "headline": "Welcome to Kitsuden",
        "description": "Build amazing content with blocks",
        "alignment": "center",
        "primaryButton": {
          "label": "Get Started",
          "url": "/signup",
          "variant": "primary"
        }
      }
    },
    {
      "type": "text",
      "content": {
        "text": "<p>Your content here...</p>",
        "format": "html"
      }
    }
  ]
}
```

### Render a Page (Public)

```bash
GET /api/page-builder/render/home
```

Response:

```json
{
  "page": {
    "id": "...",
    "title": "Homepage",
    "slug": "home",
    "metaTitle": "Homepage",
    "layout": "default"
  },
  "blocks": [
    {
      "id": "...",
      "type": "hero",
      "content": { ... },
      "columnSpan": 12,
      "mediaUrls": {
        "hero": "/api/media/preset/{mediaId}/hero",
        "large": "/api/media/preset/{mediaId}/large",
        "medium": "/api/media/preset/{mediaId}/medium",
        "small": "/api/media/preset/{mediaId}/small"
      }
    }
  ]
}
```

**Responsive Images**: The render endpoint automatically includes `mediaUrls` with transform URLs for:

- **Hero blocks**: hero, large, medium, small presets
- **Image blocks**: thumbnail, small, medium, large presets
- **Cards**: thumbnail, small, medium for each card image
- **Quote blocks**: thumbnail for author image

These URLs use kon-media's transform presets for optimized responsive images.

## API Endpoints

### Pages

| Method | Endpoint                            | Description          |
| ------ | ----------------------------------- | -------------------- |
| GET    | `/api/page-builder/pages`           | List pages           |
| GET    | `/api/page-builder/pages/:id`       | Get page with blocks |
| POST   | `/api/page-builder/pages`           | Create page          |
| PATCH  | `/api/page-builder/pages/:id`       | Update page          |
| DELETE | `/api/page-builder/pages/:id`       | Delete page          |
| POST   | `/api/page-builder/pages/:id/clone` | Clone page           |

### Blocks

| Method | Endpoint                                         | Description     |
| ------ | ------------------------------------------------ | --------------- |
| POST   | `/api/page-builder/pages/:pageId/blocks`         | Add block       |
| PATCH  | `/api/page-builder/blocks/:id`                   | Update block    |
| DELETE | `/api/page-builder/blocks/:id`                   | Delete block    |
| POST   | `/api/page-builder/pages/:pageId/blocks/reorder` | Reorder blocks  |
| POST   | `/api/page-builder/blocks/:id/duplicate`         | Duplicate block |

### Templates

| Method | Endpoint                              | Description           |
| ------ | ------------------------------------- | --------------------- |
| GET    | `/api/page-builder/templates`         | List templates        |
| POST   | `/api/page-builder/templates`         | Create template       |
| POST   | `/api/page-builder/templates/:id/use` | Increment usage count |

### Utilities

| Method | Endpoint                         | Description            |
| ------ | -------------------------------- | ---------------------- |
| GET    | `/api/page-builder/block-types`  | Get block type schemas |
| GET    | `/api/page-builder/render/:slug` | Render public page     |

## Block Types

### Hero

Large banner with headline, description, and CTAs.

```json
{
  "type": "hero",
  "content": {
    "headline": "Main Headline",
    "subheadline": "Sub headline",
    "description": "Description text",
    "mediaId": "uuid",
    "mediaType": "image",
    "alignment": "center",
    "minHeight": "lg",
    "focalPoint": { "x": 0.5, "y": 0.3 },
    "primaryButton": {
      "label": "Click Me",
      "url": "/action",
      "variant": "primary"
    }
  }
}
```

**Focal Point**: Set `focalPoint` (x,y from 0-1) for smart cropping. The image will be cropped around this point to ensure important content stays visible across all device sizes.

### Text

Rich text content.

```json
{
  "type": "text",
  "content": {
    "text": "<p>HTML content</p>",
    "format": "html",
    "alignment": "left",
    "textSize": "md"
  }
}
```

### Image

Single image with optional caption.

```json
{
  "type": "image",
  "content": {
    "mediaId": "uuid",
    "altText": "Description",
    "caption": "Image caption",
    "alignment": "center",
    "linkUrl": "https://example.com"
  }
}
```

### Grid

Multi-column container for nested content.

```json
{
  "type": "grid",
  "content": {
    "columns": 2,
    "gap": "md",
    "items": [
      {
        "id": "item-1",
        "columnSpan": 6,
        "content": {
          /* nested block content */
        }
      }
    ]
  }
}
```

### Cards

Card grid layout.

```json
{
  "type": "cards",
  "content": {
    "cards": [
      {
        "id": "card-1",
        "title": "Card Title",
        "description": "Card description",
        "mediaId": "uuid",
        "linkUrl": "/page"
      }
    ],
    "columns": 3,
    "variant": "default"
  }
}
```

### Quote

Testimonial or quote.

```json
{
  "type": "quote",
  "content": {
    "quote": "The quote text",
    "author": "Author Name",
    "authorTitle": "Job Title",
    "authorImageId": "uuid",
    "style": "large"
  }
}
```

### CTA

Call-to-action section.

```json
{
  "type": "cta",
  "content": {
    "title": "Ready to start?",
    "description": "Join us today",
    "buttonLabel": "Sign Up",
    "buttonUrl": "/signup",
    "buttonVariant": "primary",
    "alignment": "center"
  }
}
```

### Video

Self-hosted or embedded video.

```json
{
  "type": "video",
  "content": {
    "mediaId": "uuid",
    "embedUrl": "https://youtube.com/...",
    "provider": "youtube",
    "autoplay": false,
    "controls": true
  }
}
```

### Embed

HTML embed code.

```json
{
  "type": "embed",
  "content": {
    "code": "<iframe ...></iframe>",
    "caption": "Embed caption"
  }
}
```

### Divider

Horizontal separator.

```json
{
  "type": "divider",
  "content": {
    "style": "solid",
    "width": "full",
    "color": "#ccc"
  }
}
```

### Spacer

Vertical spacing.

```json
{
  "type": "spacer",
  "content": {
    "height": "lg"
  }
}
```

### Custom

Custom component (for advanced use).

```json
{
  "type": "custom",
  "content": {
    "component": "MyComponent",
    "props": { "key": "value" }
  }
}
```

## Block Styling

Each block can have these styling properties:

- `cssClass`: Custom CSS classes
- `backgroundColor`: Background color (CSS value)
- `textColor`: Text color (CSS value)
- `padding`: Spacing (`sm`, `md`, `lg`, `xl`)
- `columnSpan`: Width in grid columns (1-12)

## Page Layouts

Available layouts:

- `default`: Standard content width
- `full-width`: Edge-to-edge content
- `sidebar-left`: Content with left sidebar
- `sidebar-right`: Content with right sidebar

## Database Schema

### Tables

- `pages`: Page containers with metadata
- `blocks`: Content blocks within pages
- `block_templates`: Reusable block presets

### Enums

- `page_status`: draft, published, archived
- `block_type`: hero, text, image, video, grid, cards, quote, cta, embed, divider, spacer, custom

## Caching

Pages are cached for 60-300 seconds depending on endpoint:

- List pages: 60s
- Single page: 120s
- Render endpoint: 300s

Cache is invalidated on create/update/delete operations.

## Media Transform Integration

This kon integrates with `kon-media` to provide responsive images and smart cropping.

### Transform Presets

When rendering pages, media URLs are automatically generated using these presets:

| Preset      | Dimensions | Usage                         |
| ----------- | ---------- | ----------------------------- |
| `thumbnail` | 150x150    | Avatars, icons, author images |
| `small`     | 400x300    | Mobile, previews              |
| `medium`    | 800x600    | Tablets, main content         |
| `large`     | 1200x800   | Desktop, featured images      |
| `hero`      | 1920x1080  | Hero backgrounds, banners     |

### Focal Point for Smart Cropping

Hero blocks support focal points for intelligent cropping:

```bash
# Set focal point via kon-media API
POST /api/media/focal-point/{mediaId}
{
  "x": 0.5,  // center horizontally
  "y": 0.3   // 30% from top
}
```

Then use the focal point in Hero blocks:

```json
{
  "type": "hero",
  "content": {
    "mediaId": "uuid",
    "focalPoint": { "x": 0.5, "y": 0.3 }
  }
}
```

The focal point is passed to the transform URL as `?fp=x,y` for smart cropping.

### Usage in Frontend

```html
<!-- Hero with responsive srcset -->
<img
  src="/api/media/preset/{id}/hero"
  srcset="
    /api/media/preset/{id}/small   400w,
    /api/media/preset/{id}/medium  800w,
    /api/media/preset/{id}/large  1200w,
    /api/media/preset/{id}/hero   1920w
  "
  sizes="100vw"
  alt="Hero background"
/>
```

## License

MIT
