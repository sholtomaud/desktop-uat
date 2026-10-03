"""Harness configuration, discovered from SSM parameters written by the CDK stack."""
from __future__ import annotations

import os
from dataclasses import dataclass

import boto3


@dataclass(frozen=True)
class HarnessConfig:
    region: str
    ssm_prefix: str
    fleet_name: str
    stack_name: str
    evidence_bucket: str
    builds_bucket: str
    mcp_endpoint: str
    model_id: str
    max_concurrent: int
    mcp_service: str = "agentaccess-mcp"
    # Seconds the streaming URL stays valid for *starting* a session.
    streaming_url_validity: int = 300
    # On-demand capacity can take several minutes to provision a desktop.
    session_ready_timeout: int = 900
    presign_ttl: int = 900

    @classmethod
    def from_ssm(cls, prefix: str, region: str | None = None) -> "HarnessConfig":
        region = region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        if not region:
            raise RuntimeError("AWS_REGION is not set")
        ssm = boto3.client("ssm", region_name=region)
        values: dict[str, str] = {}
        for page in ssm.get_paginator("get_parameters_by_path").paginate(Path=prefix, Recursive=False):
            for p in page["Parameters"]:
                values[p["Name"].rsplit("/", 1)[1]] = p["Value"]

        def need(key: str) -> str:
            if key not in values:
                raise RuntimeError(f"SSM parameter {prefix}/{key} missing - is the Desktop stack deployed?")
            return values[key]

        return cls(
            region=values.get("region", region),
            ssm_prefix=prefix,
            fleet_name=need("fleet-name"),
            stack_name=need("stack-name"),
            evidence_bucket=need("evidence-bucket"),
            builds_bucket=need("builds-bucket"),
            mcp_endpoint=need("mcp-endpoint"),
            model_id=os.environ.get("UAT_MODEL_ID") or need("bedrock-model-id"),
            max_concurrent=int(need("max-concurrent-sessions")),
        )
