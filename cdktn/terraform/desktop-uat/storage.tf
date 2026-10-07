resource "aws_s3_bucket" "storage_bucket" {
  bucket_prefix = "desktop-uat-${var.environment}-"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "storage_public_access" {
  block_public_acls       = true
  block_public_policy     = true
  bucket                  = aws_s3_bucket.storage_bucket.id
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "storage_encryption" {
  bucket = aws_s3_bucket.storage_bucket.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "storage_expiry" {
  bucket = aws_s3_bucket.storage_bucket.id
  rule {
    id     = "staging"
    status = "Enabled"
    expiration {
      days = var.staging_retention_days
    }
    filter {
      prefix = "staging/"
    }
  }
  rule {
    id     = "runs"
    status = "Enabled"
    expiration {
      days = var.run_retention_days
    }
    filter {
      prefix = "runs/"
    }
  }
}

data "aws_iam_policy_document" "storage_policy_document" {
  statement {
    actions = [
      "s3:*"
    ]
    effect = "Deny"
    resources = [
      "${aws_s3_bucket.storage_bucket.arn}",
      "${aws_s3_bucket.storage_bucket.arn}/*"
    ]
    sid = "DenyInsecureTransport"
    condition {
      test = "Bool"
      values = [
        "false"
      ]
      variable = "aws:SecureTransport"
    }
    principals {
      identifiers = [
        "*"
      ]
      type = "*"
    }
  }
}

resource "aws_s3_bucket_policy" "storage_policy" {
  bucket = aws_s3_bucket.storage_bucket.id
  policy = data.aws_iam_policy_document.storage_policy_document.json
  depends_on = [
    aws_s3_bucket_public_access_block.storage_public_access,
  ]
}
