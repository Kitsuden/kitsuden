/**
 * Media Library Admin Configuration
 *
 * Configures the admin panel for Media Library.
 */

// KonAdminConfig was removed from @kitsuden/shared — inline the type
interface KonAdminConfig {
  views?: Array<{
    label: string;
    slug: string;
    icon?: string;
    defaultView?: boolean;
    component?: string;
  }>;
  category?: string;
  order?: number;
}

/**
 * Admin configuration for Media Library
 */
export const adminConfig: KonAdminConfig = {
  views: [
    {
      label: "Media Library",
      slug: "media",
      icon: "Image",
      defaultView: true,
      component: "Media", // References custom view
    },
    {
      label: "Folders",
      slug: "folders",
      icon: "Folder",
      defaultView: false,
    },
    {
      label: "Upload",
      slug: "upload",
      icon: "Upload",
      defaultView: false,
    },
  ],
};
