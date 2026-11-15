/**
 * What Retake assumes about a fontsource package on the npm registry: every name and field the fetch relies on, in one
 * table (docs/MACOS-CHECKLIST.md has the by-hand check of one real package). Nothing else in the code names a path of
 * the package or a field of the registry's answer.
 */

export const FONTSOURCE_LAYOUT = {
  registry: 'https://registry.npmjs.org',
  packageName: (id: string) => `@fontsource/${id}`,
  manifestPath: (id: string, version: string) => `/@fontsource%2f${id}/${version}`,
  latestTag: 'latest',
  tarballPath: (id: string, version: string) => `/@fontsource/${id}/-/${id}-${version}.tgz`,
  manifest: { name: 'name', version: 'version', licence: 'license', dist: 'dist', tarball: 'tarball', integrity: 'integrity' },
  integrityPrefix: 'sha512-',
  packageJson: 'package/package.json',
  licenceFile: 'package/LICENSE',
  fontFile: (id: string, weight: number, italic: boolean) => `package/files/${id}-latin-${weight}-${italic ? 'italic' : 'normal'}.woff2`,
  fontFilePattern: (id: string) => new RegExp(`^package/files/${id.replace(/-/g, '\\-')}-latin-([1-9]00)-(normal|italic)\\.woff2$`),
} as const;
