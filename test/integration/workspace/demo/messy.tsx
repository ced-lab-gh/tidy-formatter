import {useState,useEffect} from "react"
type Props={title:string,count?:number}
export function Widget({title,count=0}:Props){
const [n,setN]=useState(count);useEffect(()=>{console.log(n?.toString()??"none")},[n])
return <div className="card"   onClick={()=>setN(n+1)}><h1>{title}</h1><span>{n}</span></div>
}
