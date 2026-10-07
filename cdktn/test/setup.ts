// A deprecated cdktn API fails the test that calls it, instead of printing a
// warning nobody reads. cdktn is pre-1.0: what is deprecated now goes soon.
process.env.JSII_DEPRECATED = 'fail';
