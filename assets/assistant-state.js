(function(root){
  function canUseVoice({selectedVoice,manualSignature,formSignature,requestSignature,request}){
    if(!selectedVoice)return false;
    if(manualSignature&&manualSignature===formSignature)return true;
    return !!(request?.status==='done'&&request.voFile===selectedVoice&&requestSignature===formSignature);
  }
  function canAcceptUpload({owner,currentOwner,signature,currentSignature,path,selectedPath}){
    return !!(owner&&owner===currentOwner&&path&&path===selectedPath&&signature&&signature===currentSignature);
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={canUseVoice,canAcceptUpload};
  else root.RemixAudioState={canUseVoice,canAcceptUpload};
})(typeof globalThis!=='undefined'?globalThis:this);
