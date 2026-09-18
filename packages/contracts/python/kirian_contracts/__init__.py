"""Validate shared wire shapes; acceptance does not prove authorization or policy safety."""

from .protocol import ContractValidationError, assert_definition, parse_message

__all__ = ["ContractValidationError", "assert_definition", "parse_message"]
