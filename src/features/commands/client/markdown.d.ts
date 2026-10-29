// Bun imports a Markdown file `with { type: "text" }` as its text.
declare module "*.md" {
  const text: string;
  export default text;
}
