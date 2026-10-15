import { createAdmissionPackageFacet } from "@hypit/hypit/admission";
import { createMarkupSurfaceFacet } from "@hypit/hypit/markup";
import { createProducerPackageFacet } from "@hypit/hypit/producer";

import {
  decodeTextGenerationSurface, textGenerationComponent, textGenerationManifest,
  textGenerationMarkupSurfaces, textGenerationModuleRef,
} from "./index.js";

export const hypitPackage = {
  format: "hypit.package@1" as const,
  modules: [{ manifest: textGenerationManifest }],
  facets: [
    createProducerPackageFacet(textGenerationComponent),
    createAdmissionPackageFacet(textGenerationComponent),
    createMarkupSurfaceFacet({
      module: textGenerationModuleRef,
      declaration: textGenerationMarkupSurfaces[0],
      handler: decodeTextGenerationSurface,
    }),
  ],
};
export default hypitPackage;
