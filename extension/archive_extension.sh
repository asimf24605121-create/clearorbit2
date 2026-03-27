#!/bin/bash
cd /home/runner/workspace
rm -f assets/extension.zip
zip -r assets/extension.zip extension/ \
  -x "extension/archive_extension.sh" \
  -x "extension/.git/*"
echo ""
echo "=========================================="
echo "  extension.zip created in assets/"
echo "=========================================="
echo ""
echo "To install in Chrome:"
echo "  1. Go to chrome://extensions"
echo "  2. Enable 'Developer Mode' (top right)"
echo "  3. Unzip extension.zip to a folder"
echo "  4. Click 'Load unpacked' and select that folder"
echo ""
