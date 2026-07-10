declare module "@breejs/later" {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import later = require("later");
  export = later;
}

declare module "*.jsx" {
  const content: string;
  export default content;
}

declare module "*.js" {
  const content: string;
  export default content;
}

declare module "acorn-globals" {
  import { Node } from "acorn";
  interface GlobalReference {
    name: string;
    nodes: Node[];
  }
  function detectGlobals(source: string | Node): GlobalReference[];
  export default detectGlobals;
}
