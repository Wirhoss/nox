import { artifactPipelineService } from '../../../../services';
import { defineExtension } from '../../../extension';
import { SharpImageProcessor } from './sharpImageProcessor';

/** Registers Sharp as an ordinary artifact processor owned by this extension. */
const sharpImageExtension = defineExtension({
  manifest: { engines: { nox: '^0.1.0' }, id: 'nox.processor.sharp' },
  activate(context) {
    const artifacts = context.services.get(artifactPipelineService);
    context.subscriptions.add(artifacts.processors.register(new SharpImageProcessor()));
  },
});

export { sharpImageExtension };
