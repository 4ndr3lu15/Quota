"""The app's small preferences file, in a throwaway config folder."""
from quota import settings


def test_defaults_save_and_load(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert settings.load() == {"page": "usage"}
    settings.save({"page": "logs"})
    assert settings.load() == {"page": "logs"}
    assert settings.settings_path().parent.parent == tmp_path


def test_broken_file_reads_as_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    settings.settings_path().parent.mkdir(parents=True)
    settings.settings_path().write_text("[1, 2")
    assert settings.load() == {"page": "usage"}
    settings.settings_path().write_text("[1, 2]")
    assert settings.load() == {"page": "usage"}
