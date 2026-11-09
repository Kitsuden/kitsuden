/** English interface strings. Other languages copy this file (see ./index.ts). */
export const en = {
  "nav.home": "Home",
  "nav.blog": "Blog",
  "nav.skip": "Skip to content",
  "theme.toggle": "Toggle dark mode",
  "home.empty.title": "Your site is connected",
  "home.empty.body":
    "Create a page in the Kitsuden admin with the slug “home” (or mark a page as homepage) and publish it: it will appear here.",
  "home.latest": "Latest posts",
  "blog.title": "Blog",
  "blog.description": "Latest posts",
  "blog.empty": "No posts have been published yet.",
  "blog.unavailable": "The blog is not enabled on this Kitsuden installation.",
  "blog.readMore": "Read more",
  "blog.by": "By {author}",
  "blog.minutes": "{n} min read",
  "blog.newer": "Newer posts",
  "blog.older": "Older posts",
  "blog.page": "Page {page} of {total}",
  "blog.alsoIn": "Also available in:",
  "notFound.title": "Page not found",
  "notFound.body": "The page you are looking for does not exist or is no longer published.",
  "notFound.back": "Back to the home page",
  "unavailable.title": "Temporarily unavailable",
  "unavailable.body": "The content service is not responding. Please try again in a moment.",
  "footer.powered": "Powered by Kitsuden",
} as const;

export type MessageKey = keyof typeof en;
