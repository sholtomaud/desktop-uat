resource "aws_ssm_document" "run_run" {
  content         = <<EOF
{
  "schemaVersion": "2.2",
  "description": "Desktop UAT: one scripted run in the desktop session, reports to S3",
  "parameters": {
    "RunId": {
      "type": "String",
      "description": "Run id; reports go to runs/<RunId>/",
      "allowedPattern": "^[A-Za-z0-9._-]{1,64}$"
    },
    "BuildUrl": {
      "type": "String",
      "description": "Presigned HTTPS URL of the build zip",
      "allowedPattern": "^https://[-A-Za-z0-9.]+/[-A-Za-z0-9/._~%&=+:?]*$"
    },
    "BuildSha256": {
      "type": "String",
      "description": "SHA-256 the build must have",
      "allowedPattern": "^[a-f0-9]{64}$"
    },
    "ScenariosUrl": {
      "type": "String",
      "description": "Presigned HTTPS URL of the scenarios zip",
      "allowedPattern": "^https://[-A-Za-z0-9.]+/[-A-Za-z0-9/._~%&=+:?]*$"
    },
    "Tags": {
      "type": "String",
      "description": "Only scenarios with one of these tags; empty for all",
      "allowedPattern": "^[A-Za-z0-9,_-]*$",
      "default": ""
    },
    "StateRoot": {
      "type": "String",
      "description": "What reset_app_state may delete, e.g. %APPDATA%/UatDemo",
      "allowedPattern": "^[A-Za-z0-9%:/ ._-]{1,200}$"
    },
    "GitRef": {
      "type": "String",
      "description": "For the report",
      "allowedPattern": "^[A-Za-z0-9/._-]{0,200}$",
      "default": ""
    },
    "GitSha": {
      "type": "String",
      "description": "For the report",
      "allowedPattern": "^[a-f0-9]{0,40}$",
      "default": ""
    }
  },
  "mainSteps": [
    {
      "action": "aws:runPowerShellScript",
      "name": "run",
      "inputs": {
        "timeoutSeconds": "7200",
        "runCommand": [
          "& 'C:/Uat/Uat-Run.ps1' -RunId '{{ RunId }}' -BuildUrl '{{ BuildUrl }}' -BuildSha256 '{{ BuildSha256 }}' -ScenariosUrl '{{ ScenariosUrl }}' -Tags '{{ Tags }}' -StateRoot '{{ StateRoot }}' -GitRef '{{ GitRef }}' -GitSha '{{ GitSha }}'; exit $LASTEXITCODE"
        ]
      }
    }
  ]
}
EOF
  document_format = "JSON"
  document_type   = "Command"
  name            = "desktop-uat-${var.environment}-run"
}

resource "aws_ssm_document" "run_leave" {
  content         = <<EOF
{
  "schemaVersion": "2.2",
  "description": "Desktop UAT: leave the domain, removing the computer object, before termination",
  "mainSteps": [
    {
      "action": "aws:runPowerShellScript",
      "name": "leave",
      "inputs": {
        "timeoutSeconds": "600",
        "runCommand": [
          "& 'C:/Uat/Uat-Leave.ps1'; exit $LASTEXITCODE"
        ]
      }
    }
  ]
}
EOF
  document_format = "JSON"
  document_type   = "Command"
  name            = "desktop-uat-${var.environment}-leave"
}
