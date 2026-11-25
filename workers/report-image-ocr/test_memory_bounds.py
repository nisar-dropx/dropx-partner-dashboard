"""Unit tests for free-tier OCR memory bounds (no Tesseract binary required)."""

from __future__ import annotations

import importlib
import os
import unittest
from unittest import mock

from PIL import Image


def _reload_ocr():
    for key in list(os.environ):
        if key.startswith("REPORT_IMAGE_OCR_"):
            os.environ.pop(key, None)
    import main as ocr_main

    return importlib.reload(ocr_main)


class EnvIntTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ocr = _reload_ocr()

    def test_defaults(self) -> None:
        self.assertEqual(self.ocr.OCR_CONCURRENCY, 1)
        self.assertEqual(self.ocr.MAX_LONG_EDGE, 1600)
        self.assertEqual(self.ocr.MIN_LONG_EDGE, 1000)
        self.assertEqual(self.ocr.MAX_UPLOAD_BYTES, 8 * 1024 * 1024)

    def test_invalid_concurrency_falls_back(self) -> None:
        with mock.patch.dict(os.environ, {"REPORT_IMAGE_OCR_CONCURRENCY": "abc"}, clear=False):
            self.assertEqual(
                self.ocr._env_int("REPORT_IMAGE_OCR_CONCURRENCY", 1, minimum=1, maximum=2),
                1,
            )

    def test_concurrency_clamped(self) -> None:
        with mock.patch.dict(os.environ, {"X": "0"}):
            self.assertEqual(self.ocr._env_int("X", 1, minimum=1, maximum=2), 1)
        with mock.patch.dict(os.environ, {"X": "9"}):
            self.assertEqual(self.ocr._env_int("X", 1, minimum=1, maximum=2), 2)
        with mock.patch.dict(os.environ, {"X": "-3"}):
            self.assertEqual(self.ocr._env_int("X", 1, minimum=1, maximum=2), 1)


class PreprocessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ocr = _reload_ocr()

    def test_downscales_large_images(self) -> None:
        source = Image.new("RGB", (4000, 3000), color=(40, 40, 40))
        try:
            prepared = self.ocr.preprocess(source)
            try:
                self.assertLessEqual(max(prepared.size), self.ocr.MAX_LONG_EDGE)
                self.assertEqual(prepared.mode, "L")
            finally:
                prepared.close()
        finally:
            source.close()

    def test_upscales_tiny_images(self) -> None:
        source = Image.new("RGB", (200, 120), color=(200, 200, 200))
        try:
            prepared = self.ocr.preprocess(source)
            try:
                self.assertGreaterEqual(max(prepared.size), self.ocr.MIN_LONG_EDGE)
            finally:
                prepared.close()
        finally:
            source.close()

    def test_midsize_stays_near_original(self) -> None:
        source = Image.new("RGB", (1400, 900), color=(90, 90, 90))
        try:
            prepared = self.ocr.preprocess(source)
            try:
                long_edge = max(prepared.size)
                self.assertGreaterEqual(long_edge, self.ocr.MIN_LONG_EDGE)
                self.assertLessEqual(long_edge, self.ocr.MAX_LONG_EDGE)
            finally:
                prepared.close()
        finally:
            source.close()

    def test_preprocess_does_not_close_caller_image(self) -> None:
        source = Image.new("L", (1500, 900), color=128)
        try:
            prepared = self.ocr.preprocess(source)
            try:
                self.assertEqual(source.size, (1500, 900))
                self.assertEqual(source.getpixel((0, 0)), 128)
            finally:
                prepared.close()
        finally:
            source.close()


class CloseImageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ocr = _reload_ocr()

    def test_close_none_is_safe(self) -> None:
        self.ocr._close_image(None)

    def test_close_already_closed_is_safe(self) -> None:
        image = Image.new("L", (8, 8), color=1)
        image.close()
        self.ocr._close_image(image)


if __name__ == "__main__":
    unittest.main()
