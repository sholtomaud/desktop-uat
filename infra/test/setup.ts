// A deprecated aws-cdk-lib API fails the test that calls it, instead of printing
// a warning nobody reads. The next major release removes what is deprecated now.
process.env.JSII_DEPRECATED = 'fail';
