# Blog Editor Tests

Comprehensive test suite for the Blog Editor with SEO features.

## Test Coverage

### 1. SEO Calculator Tests (`seo-calculator.test.ts`)

Tests the algorithm that calculates SEO scores based on:

- Title length (optimal: 30-60 chars) - 20 points
- Slug presence - 10 points
- Content length (300+ chars optimal) - 20 points
- Excerpt length (120-160 chars optimal) - 10 points
- Meta title presence - 10 points
- Meta description presence - 10 points
- Featured image - 10 points
- Tags (2 points each, max 10) - 10 points

**Total: 100 points**

### 2. API SEO Tests (`api-blog-seo.test.ts`)

Tests backend handling of SEO fields:

- Creating posts with all SEO fields
- Updating SEO fields
- Validation of meta title/description lengths
- Canonical URL validation
- Structured data handling
- Featured image handling
- Tags management
- Scheduling with publishedAt

### 3. Routes Validation Tests (`routes-validation.test.ts`)

Tests input validation:

- Slug format validation (lowercase, hyphens, no special chars)
- Title length validation
- Excerpt SEO optimization warnings
- Complete SEO overrides validation
- Status transitions (draft → scheduled → published → archived)
- Tags array validation
- Robots meta validation

## Running Tests

### Run all blog tests:

```bash
pnpm test:unit tests/unit/blog
```

### Run specific test file:

```bash
pnpm test:unit tests/unit/blog/seo-calculator.test.ts
```

### Run with coverage:

```bash
pnpm test:unit:coverage tests/unit/blog
```

### Run in watch mode:

```bash
pnpm test:unit:watch tests/unit/blog
```

## E2E Tests

### Run E2E tests:

```bash
pnpm test:e2e tests/e2e/blog/editor-seo.e2e.spec.ts
```

### Run with UI:

```bash
pnpm test:e2e:ui tests/e2e/blog/editor-seo.e2e.spec.ts
```

## Test Structure

```
tests/
├── unit/
│   └── blog/
│       ├── seo-calculator.test.ts          # SEO scoring algorithm
│       ├── api-blog-seo.test.ts            # Backend API tests
│       ├── routes-validation.test.ts       # Input validation
│       ├── vitest.config.ts                # Test config
│       └── README.md                       # This file
└── e2e/
    └── blog/
        └── editor-seo.e2e.spec.ts          # Full user flows
```

## Key Test Scenarios

### SEO Score Calculation

- ✅ Perfect post (all fields optimal) = 100%
- ✅ Empty post = 0%
- ✅ Partial completion = proportional score
- ✅ Tag capping at 5 tags (10 points max)

### Validation

- ✅ Meta title max 60 chars
- ✅ Meta description max 160 chars
- ✅ Valid canonical URLs only
- ✅ Slug format enforcement
- ✅ Future dates for scheduled posts
- ✅ Max 20 tags
- ✅ Unique tags requirement

### API Integration

- ✅ Full SEO object storage
- ✅ Partial updates
- ✅ Null/empty handling
- ✅ Unicode support
- ✅ Complex structuredData

## Continuous Integration

Add to your CI pipeline:

```yaml
- name: Run Blog Tests
  run: |
    pnpm test:unit tests/unit/blog
    pnpm test:e2e tests/e2e/blog
```
