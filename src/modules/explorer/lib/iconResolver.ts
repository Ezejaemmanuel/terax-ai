import vscodeIconsData from "@iconify-json/vscode-icons/icons.json";
import { EXT_TO_LANGUAGE_ID } from "./constants";
import * as fileIconsMod from "./fileIcons";
import * as folderIconsMod from "./folderIcons";

const catFileNames = fileIconsMod.fileNames as Record<string, string>;
const catFileExtensions = fileIconsMod.fileExtensions as Record<string, string>;
const catLanguageIds = fileIconsMod.languageIds as Record<string, string>;
const catFolderNames = folderIconsMod.folderNames as Record<string, string>;

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
};

const vs = vscodeIconsData as unknown as IconifySet;
const VS_W = vs.width ?? 32;
const VS_H = vs.height ?? 32;

// Maps catppuccin-style icon keys (from fileIcons.ts) to vscode-icons icon names
const FILE_ICON_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  typescript: "file-type-typescript",
  "typescript-react": "file-type-reactts",
  "typescript-def": "file-type-typescriptdef",
  "typescript-config": "file-type-tsconfig",
  "typescript-test": "file-type-typescriptdef",
  javascript: "file-type-js",
  "javascript-react": "file-type-reactjs",
  "javascript-config": "file-type-js",
  "javascript-map": "file-type-jsmap",
  "javascript-test": "file-type-js",
  vue: "file-type-vue",
  "vue-config": "file-type-vue",
  svelte: "file-type-svelte",
  "svelte-config": "file-type-svelte",
  astro: "file-type-astro",
  "astro-config": "file-type-astro",
  // Python
  python: "file-type-python",
  "python-config": "file-type-python",
  "python-compiled": "file-type-python",
  // Go
  go: "file-type-go",
  "go-mod": "file-type-go",
  "go-template": "file-type-go",
  // Rust
  rust: "file-type-rust",
  "rust-config": "file-type-rust",
  cargo: "file-type-cargo",
  "cargo-lock": "file-type-cargo",
  // C / C++
  c: "file-type-c",
  "c-header": "file-type-cheader",
  cpp: "file-type-cpp",
  "cpp-header": "file-type-cppheader",
  // JVM
  java: "file-type-java",
  "java-class": "file-type-java",
  "java-jar": "file-type-java",
  kotlin: "file-type-kotlin",
  scala: "file-type-scala",
  groovy: "file-type-groovy",
  gradle: "file-type-gradle",
  // .NET
  csharp: "file-type-csharp",
  // Ruby
  ruby: "file-type-ruby",
  "ruby-gem": "file-type-ruby",
  "ruby-gem-lock": "file-type-ruby",
  // PHP
  php: "file-type-php",
  phtml: "file-type-phtml",
  // Swift
  swift: "file-type-swift",
  // Shell
  bash: "file-type-shell",
  shell: "file-type-shell",
  batch: "file-type-batch",
  powershell: "file-type-powershell",
  // Web
  html: "file-type-html",
  css: "file-type-css",
  "css-map": "file-type-cssmap",
  sass: "file-type-sass",
  less: "file-type-less",
  // Data
  json: "file-type-json",
  "json-schema": "file-type-json",
  yaml: "file-type-yaml",
  toml: "file-type-toml",
  xml: "file-type-xml",
  csv: "file-type-table",
  sql: "file-type-sql",
  graphql: "file-type-graphql",
  // Docs / Text
  markdown: "file-type-markdown",
  "markdown-mdx": "file-type-mdx",
  text: "file-type-text",
  readme: "file-type-readme",
  log: "file-type-log",
  license: "file-type-license",
  changelog: "file-type-changelog",
  pdf: "file-type-pdf2",
  // Config / Env
  env: "file-type-dotenv",
  envrc: "file-type-dotenv",
  editorconfig: "file-type-editorconfig",
  git: "file-type-git",
  "cursor-ignore": "file-type-git",
  // Build / Infra
  docker: "file-type-docker",
  "docker-compose": "file-type-docker",
  "docker-ignore": "file-type-docker",
  makefile: "file-type-makefile",
  cmake: "file-type-cmake",
  terraform: "file-type-terraform",
  nginx: "file-type-nginx",
  apache: "file-type-apache",
  // Package managers
  npm: "file-type-npm",
  "npm-lock": "file-type-npm",
  "npm-ignore": "file-type-npm",
  pnpm: "file-type-pnpm",
  "pnpm-lock": "file-type-pnpm",
  yarn: "file-type-yarn",
  "yarn-lock": "file-type-yarn",
  "package-json": "file-type-package",
  bun: "file-type-bun",
  "bun-lock": "file-type-bun",
  deno: "file-type-deno",
  deno_lock: "file-type-deno",
  // Frameworks / Tooling
  angular: "file-type-angular",
  next: "file-type-next",
  "next-config": "file-type-next",
  nuxt: "file-type-nuxt",
  "nuxt-ignore": "file-type-nuxt",
  nest: "file-type-nestjs",
  vite: "file-type-vite",
  vitest: "file-type-vitest",
  remix: "file-type-remix",
  storybook: "file-type-storybook",
  "storybook-svelte": "file-type-storybook",
  "storybook-vue": "file-type-storybook",
  gatsby: "file-type-gatsby",
  babel: "file-type-babel",
  webpack: "file-type-webpack",
  rollup: "file-type-rollup",
  esbuild: "file-type-esbuild",
  tailwind: "file-type-tailwind",
  postcss: "file-type-postcss",
  prettier: "file-type-prettier",
  "prettier-ignore": "file-type-prettier",
  eslint: "file-type-eslint",
  "eslint-ignore": "file-type-eslint",
  jest: "file-type-jest",
  playwright: "file-type-playwright",
  cypress: "file-type-cypress",
  prisma: "file-type-prisma",
  tauri: "file-type-tauri",
  "tauri-ignore": "file-type-tauri",
  turbo: "file-type-turbo",
  nx: "file-type-nx",
  "nx-ignore": "file-type-nx",
  renovate: "file-type-renovate",
  dependabot: "file-type-dependabot",
  // VCS / CI
  github: "file-type-github",
  gitlab: "file-type-gitlab",
  bitbucket: "file-type-bitbucket",
  "circle-ci": "file-type-circleci",
  "azure-pipelines": "file-type-azure-pipelines",
  heroku: "file-type-heroku",
  netlify: "file-type-netlify",
  firebase: "file-type-firebase",
  gcp: "file-type-gcp",
  sentry: "file-type-sentry",
  vercel: "file-type-vercel",
  "vercel-ignore": "file-type-vercel",
  // Languages (less common)
  lua: "file-type-lua",
  "lua-check": "file-type-lua",
  "lua-client": "file-type-lua",
  "lua-server": "file-type-lua",
  "lua-test": "file-type-lua",
  "lua-rocks": "file-type-lua",
  luau: "file-type-lua",
  "luau-check": "file-type-lua",
  "luau-client": "file-type-lua",
  "luau-config": "file-type-lua",
  "luau-server": "file-type-lua",
  "luau-test": "file-type-lua",
  haskell: "file-type-haskell",
  elixir: "file-type-elixir",
  erlang: "file-type-erlang",
  ocaml: "file-type-ocaml",
  fsharp: "file-type-fsharp",
  nim: "file-type-nim",
  zig: "file-type-zig",
  dart: "file-type-dartlang",
  "dart-generated": "file-type-dartlang-generated",
  r: "file-type-r",
  julia: "file-type-julia",
  matlab: "file-type-matlab",
  fortran: "file-type-fortran",
  cobol: "file-type-cobol",
  assembly: "file-type-assembly",
  perl: "file-type-perl",
  clojure: "file-type-clojure",
  crystal: "file-type-crystal",
  elm: "file-type-elm",
  reason: "file-type-reason",
  gleam: "file-type-gleam",
  "gleam-config": "file-type-gleam",
  vim: "file-type-vim",
  // Media / Assets
  image: "file-type-image",
  audio: "file-type-audio",
  video: "file-type-video",
  font: "file-type-font",
  svg: "file-type-svg",
  // Binary / Archive
  binary: "file-type-binary",
  zip: "file-type-zip",
  exe: "file-type-exe",
  // Misc
  key: "file-type-key",
  certificate: "file-type-cert",
  database: "file-type-db",
  diff: "file-type-diff",
  drawio: "file-type-drawio",
  figma: "file-type-figma",
  todo: "file-type-todo",
  favicon: "file-type-favicon",
  // Drizzle / other ORM
  "drizzle-orm": "file-type-drizzle",
};

// Maps catppuccin folder names (from folderIcons.ts, e.g. "folder_src") to vscode-icons names
const FOLDER_ICON_MAP: Record<string, string> = {
  folder_src: "folder-type-src",
  folder_components: "folder-type-component",
  folder_config: "folder-type-config",
  folder_api: "folder-type-api",
  folder_app: "folder-type-app",
  folder_assets: "folder-type-asset",
  folder_audio: "folder-type-audio",
  folder_aws: "folder-type-aws",
  folder_cargo: "folder-type-cargo",
  folder_client: "folder-type-client",
  folder_coverage: "folder-type-coverage",
  folder_cursor: "folder-type-cursor",
  folder_cypress: "folder-type-cypress",
  folder_database: "folder-type-db",
  folder_devcontainer: "folder-type-devcontainer",
  folder_dist: "folder-type-dist",
  folder_docker: "folder-type-docker",
  folder_docs: "folder-type-docs",
  folder_download: "folder-type-download",
  folder_fastlane: "folder-type-script",
  folder_firebase: "folder-type-firebase",
  folder_fonts: "folder-type-fonts",
  folder_forgejo: "folder-type-github",
  folder_functions: "folder-type-functions",
  folder_gcp: "folder-type-gcp",
  folder_git: "folder-type-git",
  folder_github: "folder-type-github",
  folder_gitlab: "folder-type-gitlab",
  folder_gradle: "folder-type-gradle",
  folder_graphql: "folder-type-graphql",
  folder_hooks: "folder-type-hook",
  folder_husky: "folder-type-husky",
  folder_images: "folder-type-images",
  folder_include: "folder-type-include",
  folder_intellij: "folder-type-idea",
  folder_javascript: "folder-type-js",
  folder_kubernetes: "folder-type-kubernetes",
  folder_lib: "folder-type-library",
  folder_linux: "folder-type-linux",
  folder_locales: "folder-type-locale",
  folder_luau: "folder-type-common",
  folder_lune: "folder-type-common",
  folder_macos: "folder-type-macos",
  folder_messages: "folder-type-notification",
  folder_middleware: "folder-type-middleware",
  folder_mocks: "folder-type-mock",
  folder_moonrepo: "folder-type-moonrepo",
  folder_next: "folder-type-next",
  folder_nix: "folder-type-nix",
  folder_node: "folder-type-node",
  folder_nuxt: "folder-type-nuxt",
  folder_packages: "folder-type-package",
  folder_pesde: "folder-type-package",
  folder_plugins: "folder-type-plugin",
  folder_prisma: "folder-type-prisma",
  folder_private: "folder-type-private",
  folder_proto: "folder-type-interfaces",
  folder_public: "folder-type-public",
  folder_queue: "folder-type-notification",
  folder_redux: "folder-type-redux",
  folder_renovate: "folder-type-dependabot",
  folder_roblox: "folder-type-minecraft",
  folder_routes: "folder-type-route",
  folder_sass: "folder-type-sass",
  folder_scripts: "folder-type-script",
  folder_security: "folder-type-private",
  folder_server: "folder-type-server",
  folder_shared: "folder-type-shared",
  folder_storybook: "folder-type-story",
  folder_styles: "folder-type-style",
  folder_svg: "folder-type-css",
  folder_tauri: "folder-type-tauri",
  folder_temp: "folder-type-temp",
  folder_templates: "folder-type-template",
  folder_tests: "folder-type-test",
  folder_themes: "folder-type-theme",
  folder_turbo: "folder-type-turbo",
  folder_types: "folder-type-typings",
  folder_upload: "folder-type-www",
  folder_utils: "folder-type-tools",
  folder_vercel: "folder-type-vercel",
  folder_video: "folder-type-video",
  folder_views: "folder-type-view",
  folder_vscode: "folder-type-vscode",
  folder_windows: "folder-type-windows",
  folder_workflows: "folder-type-azurepipelines",
  folder_wxt: "folder-type-tools",
  folder_xcode: "folder-type-ios",
  folder_xmake: "folder-type-tools",
  folder_yarn: "folder-type-yarn",
  folder_android: "folder-type-android",
  folder_animation: "folder-type-asset",
  folder_admin: "folder-type-common",
  folder_benchmark: "folder-type-test",
  folder_caddy: "folder-type-config",
  folder_command: "folder-type-cli",
  folder_composables: "folder-type-common",
  folder_connection: "folder-type-db",
  folder_constant: "folder-type-common",
  folder_content: "folder-type-docs",
  folder_controllers: "folder-type-controller",
  folder_core: "folder-type-common",
  folder_debug: "folder-type-log",
};

const DEFAULT_FILE = "default-file";
const DEFAULT_FOLDER = "default-folder";
const DEFAULT_FOLDER_OPEN = "default-folder-opened";

const dataUrlCache = new Map<string, string>();

function vsBody(iconName: string): string | null {
  const direct = vs.icons[iconName];
  if (direct) return direct.body;
  const alias = vs.aliases?.[iconName];
  if (alias) {
    const parent = vs.icons[alias.parent];
    if (parent) return parent.body;
  }
  return null;
}

function buildDataUrl(iconName: string): string | null {
  const cached = dataUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const body = vsBody(iconName);
  if (!body) {
    dataUrlCache.set(iconName, "");
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VS_W} ${VS_H}">${body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  dataUrlCache.set(iconName, url);
  return url;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

function resolveFileIcon(catName: string): string | null {
  const vsName = FILE_ICON_MAP[catName] ?? `file-type-${catName}`;
  return buildDataUrl(vsName);
}

function resolveFolderIcon(catFolderKey: string, opened: boolean): string | null {
  const vsBase = FOLDER_ICON_MAP[catFolderKey];
  if (vsBase) {
    const target = opened ? `${vsBase}-opened` : vsBase;
    return buildDataUrl(target) ?? buildDataUrl(vsBase);
  }
  return null;
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const byName = catFileNames[lower];
  if (byName) {
    const url = resolveFileIcon(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = catFileExtensions[ext];
    if (iconName) {
      const url = resolveFileIcon(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = catLanguageIds[langId];
      if (iconByLang) {
        const url = resolveFileIcon(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return buildDataUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();
  const catKey = catFolderNames[lower];
  if (catKey) {
    const url = resolveFolderIcon(catKey, expanded);
    if (url) return url;
  }
  return buildDataUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
