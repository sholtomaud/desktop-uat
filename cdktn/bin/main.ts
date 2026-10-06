/**
 * Synthesizes every environment to HCL in $CDKTN_OUTDIR. Run through
 * `make tf-synth`, which formats the result and writes it to terraform/.
 */
import { App } from 'cdktn';
import { uatConfig } from '../lib/config';
import { UatStack } from '../lib/uat-stack';

// cdktn reads this as each stack is constructed: HCL, not JSON.
process.env.SYNTH_HCL_OUTPUT = 'true';

const app = new App({ outdir: process.env.CDKTN_OUTDIR ?? 'cdktf.out', hclOutput: true });
const config = uatConfig();
new UatStack(app, `desktop-uat-${config.envName}`, { config });
app.synth();
