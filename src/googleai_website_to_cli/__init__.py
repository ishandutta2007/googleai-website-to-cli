"""
googleai-website-to-cli
~~~~~~~~~~~~~~~~~~~~~~~

RPA-powered CLI tool that converts Google Search AI Mode (google.com/search?udm=50) interactions
into a command-line interface using a paired browser extension.
"""

__version__ = "0.1.0"
__author__ = "Ishan Dutta"

from googleai_website_to_cli.browser import GoogleAIBridge
from googleai_website_to_cli.googleai import GoogleAIAutomation

__all__ = ["GoogleAIBridge", "GoogleAIAutomation", "__version__"]
