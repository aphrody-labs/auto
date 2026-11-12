param([string]$Source,[string]$Destination)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
if(-not $Source -or -not $Destination){
  & bun (Join-Path $PSScriptRoot 'video-lancement-voix.ts')
  exit $LASTEXITCODE
}
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice('Microsoft Julie')
  $synth.Rate=0
  $synth.Volume=100
  $format=[System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
  $scenes=Get-Content -LiteralPath $Source -Encoding UTF8 -Raw | ConvertFrom-Json
  Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -SourceIdentifier AutoVoixProgress | Out-Null
  $resultats=@()
  foreach($scene in $scenes){
    Get-Event -SourceIdentifier AutoVoixProgress -ErrorAction SilentlyContinue | Remove-Event
    $path=Join-Path $Destination ($scene.id+'-voix.wav')
    $synth.SetOutputToWaveFile($path,$format)
    $synth.Speak($scene.texte)
    $synth.SetOutputToNull()
    $mots=@(Get-Event -SourceIdentifier AutoVoixProgress -ErrorAction SilentlyContinue | ForEach-Object { @{texte=$_.SourceEventArgs.Text;position=$_.SourceEventArgs.CharacterPosition;longueur=$_.SourceEventArgs.CharacterCount;secondes=$_.SourceEventArgs.AudioPosition.TotalSeconds} })
    $resultats+=@{id=$scene.id;mots=$mots}
    Write-Output ('Voix française : '+$scene.id)
  }
  @{voix=$synth.Voice.Name;langue=$synth.Voice.Culture.Name;frequence=48000;canaux=1;scenes=$resultats} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Destination 'paroles-fr.json') -Encoding UTF8
} finally {
  Unregister-Event -SourceIdentifier AutoVoixProgress -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier AutoVoixProgress -ErrorAction SilentlyContinue | Remove-Event
  $synth.Dispose()
}
