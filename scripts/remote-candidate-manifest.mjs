export function remoteCandidateManifest(source) {
  const version = /\bandroid:versionName="([A-Za-z0-9._-]+)"/.exec(source)?.[1];
  if (!version || !source.includes('android:label="cccodroid"')) throw new Error("Unrecognized host manifest");
  return {
    version: version + "-component-host-candidate",
    xml: source.replace('android:label="cccodroid"', 'android:label="CC Component Host Candidate"')
      .replace(`android:versionName="${version}"`, `android:versionName="${version}-component-host-candidate"`),
  };
}
