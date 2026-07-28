import { defineConfig } from "vitepress";

export default defineConfig({
  title: "No Forgetti",
  description: "Project-scoped persistent memory and self-forming skills for Pi.",
  base: "/no-forgetti/",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#315fce" }],
    ["link", { rel: "icon", href: "/no-forgetti/logo.jpg" }],
  ],
  themeConfig: {
    logo: "/logo.jpg",
    siteTitle: "No Forgetti",
    search: { provider: "local" },
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "External mode", link: "/external-mode/" },
      { text: "Reference", link: "/reference/commands" },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Getting started", link: "/getting-started" },
        ],
      },
      {
        text: "Core guide",
        items: [
          { text: "Project memory", link: "/guide/memory" },
          { text: "Project skills", link: "/guide/project-skills" },
        ],
      },
      {
        text: "External mode",
        collapsed: false,
        items: [
          { text: "How it works", link: "/external-mode/" },
          { text: "Set up external mode", link: "/external-mode/setup" },
          { text: "Run on macOS", link: "/external-mode/macos" },
          { text: "Run on Linux", link: "/external-mode/linux" },
          { text: "Operate and troubleshoot", link: "/external-mode/operations" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Commands", link: "/reference/commands" },
          { text: "Storage", link: "/reference/storage" },
          { text: "Security", link: "https://github.com/Jeecabs/no-forgetti/blob/main/SECURITY.md" },
        ],
      },
      {
        text: "Internals",
        collapsed: true,
        items: [
          { text: "External curator architecture", link: "/architecture/external-curator" },
          { text: "Durable review spool", link: "/adr/0001-durable-review-spool" },
          { text: "Evidence and projection", link: "/adr/0002-evidence-claims-projection" },
        ],
      },
    ],
    outline: { level: [2, 3] },
    editLink: {
      pattern: "https://github.com/Jeecabs/no-forgetti/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/Jeecabs/no-forgetti" },
    ],
    footer: {
      message: "No Forgetti is open source under the MIT License.",
      copyright: "Documentation for the current release.",
    },
  },
});
