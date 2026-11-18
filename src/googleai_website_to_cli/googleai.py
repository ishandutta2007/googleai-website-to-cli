"""
Google AI Automation (Extension-based)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

High-level orchestration of Google Search AI Mode (google.com/search?udm=50)
interactions via the paired browser extension. All DOM operations are performed
by the extension's content script running inside the user's real browser session.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from googleai_website_to_cli.browser import GoogleAIBridge

logger = logging.getLogger(__name__)


class GoogleAIAutomation:
    """Orchestrates Google AI Search interactions through the browser extension bridge.

    Sends high-level commands to the extension, which handles the actual
    DOM manipulation inside the user's logged-in browser.
    """

    def __init__(
        self,
        bridge: GoogleAIBridge,
        max_wait_seconds: int = 180,
        poll_interval: float = 3.0,
    ) -> None:
        self.bridge = bridge
        self.max_wait_seconds = max_wait_seconds
        self.poll_interval = poll_interval
        self._initial_footer_count = 0
        self._initial_copy_count = 0
        self._initial_codeblock_count = 0

    async def find_or_open_googleai_tab(self) -> int:
        """Find an existing Google AI (udm=50) tab or open a new one.

        Returns:
            The tab ID of the Google AI tab.
        """
        # Search for existing Google AI tabs
        result = await self.bridge.send_command("find_googleai_tab")
        tabs = result.get("tabs", [])

        if tabs:
            tab = tabs[0]
            tab_id = tab["id"]
            logger.info("Found Google AI tab: %s (id=%d)", tab.get("title", ""), tab_id)
            # Activate the tab and bring window to focus
            await self.bridge.send_command("activate_tab", tabId=tab_id)
            return tab_id
        else:
            logger.info("No Google AI tab found. Opening a new one (https://www.google.com/search?udm=50)...")
            result = await self.bridge.send_command("open_googleai_tab", timeout=30)
            tab_id = result["tabId"]
            logger.info("Opened new Google AI tab (id=%d)", tab_id)
            return tab_id

    async def send_prompt(
        self,
        prompt_text: str,
        max_retries: int = 5,
        retry_delay: float = 3.0,
    ) -> None:
        """Send a prompt to the Google AI search input box.

        The extension's content script handles finding the input element,
        setting the value, and submitting with Enter or the search button.

        Retries up to ``max_retries`` times on transient failures.

        Args:
            prompt_text: The full prompt text to send.
            max_retries: Maximum number of send attempts.
            retry_delay: Seconds to wait between retries.
        """
        logger.info("Sending prompt to Google AI (%d chars)...", len(prompt_text))

        # Capture initial counts before sending
        try:
            initial_status = await self.bridge.send_command(
                "check_response_status", timeout=5
            )
            diag = initial_status.get("diag", {})
            self._initial_footer_count = diag.get("actionFooters", 0)
            self._initial_copy_count = diag.get("copyButtonsCount", 0)
            self._initial_codeblock_count = initial_status.get("codeBlockCount", 0)
            logger.info(
                "Initial state: footers=%d, copyBtns=%d, codeBlocks=%d",
                self._initial_footer_count,
                self._initial_copy_count,
                self._initial_codeblock_count,
            )
        except Exception:
            self._initial_footer_count = 0
            self._initial_copy_count = 0
            self._initial_codeblock_count = 0

        last_exc: Exception | None = None
        for attempt in range(1, max_retries + 1):
            try:
                await self.bridge.send_command(
                    "send_prompt",
                    prompt=prompt_text,
                    timeout=30,
                )
                logger.info(
                    "Prompt submitted successfully (attempt %d/%d).",
                    attempt,
                    max_retries,
                )
                return
            except (ConnectionError, TimeoutError, RuntimeError, OSError) as exc:
                last_exc = exc
                logger.warning(
                    "send_prompt failed (attempt %d/%d): %s",
                    attempt,
                    max_retries,
                    exc,
                )
                if attempt < max_retries:
                    logger.info("Retrying send_prompt in %.1fs...", retry_delay)
                    await asyncio.sleep(retry_delay)

        raise RuntimeError(f"Failed to send prompt after {max_retries} attempts. Last error: {last_exc}")

    async def wait_for_response(self) -> None:
        """Wait for Google AI to finish generating its response.

        Strategy:
        Wait until new footers, copy buttons, or new code blocks appear
        exceeding the pre-prompt count, or the new code block count is positive
        and generation indicator is absent.
        """
        logger.info(
            "Waiting for Google AI response (up to %ds)...",
            self.max_wait_seconds,
        )

        # Initial delay to let generation start
        await asyncio.sleep(3)

        start_time = asyncio.get_event_loop().time()
        prev_footers = None
        prev_copy_buttons = None
        prev_codeblocks = None
        consecutive_stable_polls = 0
        last_content_length = -1

        while (asyncio.get_event_loop().time() - start_time) < self.max_wait_seconds:
            try:
                status = await self.bridge.send_command(
                    "check_response_status", timeout=10
                )
            except Exception as exc:
                logger.info("Status check failed: %s", exc)
                await asyncio.sleep(self.poll_interval)
                continue

            diag = status.get("diag", {})
            footer_count = diag.get("actionFooters", 0)
            copy_buttons_count = diag.get("copyButtonsCount", 0)
            new_copy_buttons_count = diag.get("newCopyButtonsCount", 0)
            code_block_count = status.get("codeBlockCount", 0)
            new_code_block_count = status.get("newCodeBlockCount", 0)
            is_generating = diag.get("isGenerating", False)
            content_length = status.get("contentLength", 0)
            elapsed = int(asyncio.get_event_loop().time() - start_time)

            logger.info(
                "Poll: footers=%d (prev=%s) copyBtns=%d (prev=%s) codeBlocks=%d (prev=%s) generating=%s elapsed=%ds",
                footer_count,
                prev_footers,
                copy_buttons_count,
                prev_copy_buttons,
                code_block_count,
                prev_codeblocks,
                is_generating,
                elapsed,
            )

            # Condition: detect increment between consecutive polls (last poll values)
            if not is_generating:
                if new_code_block_count > 0:
                    consecutive_stable_polls += 1
                    if consecutive_stable_polls >= 2:
                        logger.info(
                            "DONE! New response content detected (newCodeBlocks=%d, newCopyBtns=%d). Returning.",
                            new_code_block_count,
                            new_copy_buttons_count,
                        )
                        await asyncio.sleep(1.0)
                        return
                elif (
                    prev_footers is not None
                    and (
                        footer_count > prev_footers
                        or (prev_codeblocks is not None and code_block_count > prev_codeblocks)
                        or (prev_copy_buttons is not None and copy_buttons_count > prev_copy_buttons)
                    )
                ):
                    consecutive_stable_polls += 1
                    if consecutive_stable_polls >= 2:
                        logger.info(
                            "DONE! Increment detected (footers: %s->%d, codeBlocks: %s->%d, copyBtns: %s->%d). Returning.",
                            prev_footers,
                            footer_count,
                            prev_codeblocks,
                            code_block_count,
                            prev_copy_buttons,
                            copy_buttons_count,
                        )
                        await asyncio.sleep(1.0)
                        return
                else:
                    consecutive_stable_polls = 0
            else:
                consecutive_stable_polls = 0

            prev_footers = footer_count
            prev_copy_buttons = copy_buttons_count
            prev_codeblocks = code_block_count
            last_content_length = content_length
            await asyncio.sleep(self.poll_interval)

        logger.warning(
            "Timed out after %ds while waiting for response.", self.max_wait_seconds
        )

    async def extract_last_code_block(
        self,
        max_retries: int = 5,
        retry_delay: float = 3.0,
    ) -> Optional[str]:
        """Extract the text of the last code block from the response.

        Retries up to ``max_retries`` times on transient failures.
        """
        for attempt in range(1, max_retries + 1):
            try:
                result = await self.bridge.send_command(
                    "extract_last_code_block", timeout=15
                )
                text = result.get("text")
                if text:
                    method = result.get("method", "unknown")
                    logger.info(
                        "Extracted code block (%d chars) via %s (attempt %d/%d).",
                        len(text),
                        method,
                        attempt,
                        max_retries,
                    )
                    return text.strip()
                else:
                    logger.warning(
                        "No code blocks found (attempt %d/%d).",
                        attempt,
                        max_retries,
                    )
            except (RuntimeError, ConnectionError, OSError) as exc:
                logger.warning(
                    "Code block extraction failed (attempt %d/%d): %s",
                    attempt,
                    max_retries,
                    exc,
                )

            if attempt < max_retries:
                logger.info("Retrying code block extraction in %.1fs...", retry_delay)
                await asyncio.sleep(retry_delay)

        logger.warning("Could not extract code block after %d attempts.", max_retries)
        return None

    async def extract_full_response(
        self,
        max_retries: int = 5,
        retry_delay: float = 3.0,
    ) -> Optional[str]:
        """Extract the full text of the latest AI response.

        Retries up to ``max_retries`` times on transient failures.
        """
        for attempt in range(1, max_retries + 1):
            try:
                result = await self.bridge.send_command(
                    "extract_full_response", timeout=15
                )
                text = result.get("text")
                if text:
                    logger.info(
                        "Extracted full response (%d chars, attempt %d/%d).",
                        len(text),
                        attempt,
                        max_retries,
                    )
                    return text.strip()
                else:
                    logger.warning(
                        "No response content found (attempt %d/%d).",
                        attempt,
                        max_retries,
                    )
            except (RuntimeError, ConnectionError, OSError) as exc:
                logger.warning(
                    "Full response extraction failed (attempt %d/%d): %s",
                    attempt,
                    max_retries,
                    exc,
                )

            if attempt < max_retries:
                logger.info(
                    "Retrying full response extraction in %.1fs...", retry_delay
                )
                await asyncio.sleep(retry_delay)

        logger.warning(
            "Could not extract full response after %d attempts.", max_retries
        )
        return None
