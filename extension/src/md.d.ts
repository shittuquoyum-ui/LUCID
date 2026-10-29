/** Prompt files are bundled as plain text (esbuild's text loader). */
declare module '*.md' {
  const text: string;
  export default text;
}
