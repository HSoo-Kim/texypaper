// Windows canonical paths carry a verbatim prefix (\\?\C:\… or \\?\UNC\server\share). It is an implementation detail,
// so every place that shows a project path to the user removes it; stored and compared values stay untouched.
export function displayPath(path:string):string{
  if(path.startsWith('\\\\?\\UNC\\'))return `\\\\${path.slice(8)}`;
  return path.startsWith('\\\\?\\')?path.slice(4):path;
}
