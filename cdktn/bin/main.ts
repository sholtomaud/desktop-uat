/**
 * Synthesizes the module to HCL in $CDKTN_OUTDIR. Run through `make cdktn-synth`,
 * which formats it, splits it into files, and writes it to terraform/.
 */
import { App } from 'cdktn';
import { UatStack } from '../lib/uat-stack';

// cdktn reads this as each stack is constructed: HCL, not JSON.
process.env.SYNTH_HCL_OUTPUT = 'true';

const app = new App({ outdir: process.env.CDKTN_OUTDIR ?? 'cdktf.out', hclOutput: true });
new UatStack(app, 'desktop-uat');
app.synth();
