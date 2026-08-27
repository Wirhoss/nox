import { artifactPipelineService, defineExtension } from '@nox/extension-api';

import { SharpImageProcessor } from './sharpImageProcessor';

/** Registers Sharp as an ordinary artifact processor owned by this extension. */
const sharpImageExtension = defineExtension({
  activate(context) {
    const artifacts = context.services.get(artifactPipelineService);
    context.subscriptions.add(artifacts.processors.register(new SharpImageProcessor()));
  },
});

export default sharpImageExtension;
export { sharpImageExtension };
