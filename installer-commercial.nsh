; The normal and Geek editions use the same app ID and preserve the shared data directory.
ManifestDPIAware true
!macro customInit
  System::Call 'USER32::SetProcessDPIAware()'
!macroend
