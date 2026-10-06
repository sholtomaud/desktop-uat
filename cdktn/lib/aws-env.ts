/** Where the configuration is applied, as Terraform references resolved at plan time. */
export interface AwsEnv {
  partition: string;
  account: string;
  region: string;
}
