"""ReadMediaFile tool description (aligned to Moonshot's kimi-code read-media.md)."""

_READ_MEDIA_FILE_TOOL_NAME = "ReadMediaFile"


def get_read_media_file_description() -> str:
    return (
        "Read media content from a file. Image files (png, jpeg, webp, gif) are "
        "returned as viewable media you can see.\n\n"
        "Tips:\n"
        "- After generating or editing an image or screenshot with Bash or a "
        "script, read it back with this tool to verify the result looks right "
        "before continuing.\n"
        "- Large images are downsampled to fit vision limits. The <system> tag "
        "in the result reports the mime type, byte size, original pixel "
        "dimensions, and how the image was delivered (untouched, downsampled, "
        "cropped, or native resolution). Compute absolute coordinates from the "
        "original dimensions, never by measuring the displayed copy.\n"
        "- When a downsampled overview hides fine detail (small text, dense "
        "UI), call again with `region` (original-image pixel coordinates) to "
        "view that crop at full fidelity, or set `full_resolution` when the "
        "whole image already fits.\n"
        "- Refuses files over 100 MB and non-image files. Video files are not "
        "supported yet — image files only."
    )
