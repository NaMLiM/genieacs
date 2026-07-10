declare module "views-bundle" {
  const views: Record<string, (node: unknown) => unknown>;
  export default views;
}
